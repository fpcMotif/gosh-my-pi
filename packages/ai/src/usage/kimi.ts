import { $env } from "@oh-my-pi/pi-utils";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { getKimiCommonHeaders, refreshKimiToken } from "../utils/oauth/kimi";
import { toNumber } from "./shared";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const USAGE_PATH = "usages";

interface KimiUsagePayload {
	usage?: unknown;
	limits?: unknown;
}

type KimiUsageRow = {
	label: string;
	used?: number;
	limit?: number;
	remaining?: number;
	resetsAt?: number;
	window?: UsageWindow;
};

function normalizeBaseUrl(baseUrl?: string): string {
	const envBase = $env.KIMI_CODE_BASE_URL?.trim();
	const candidate =
		baseUrl !== undefined && baseUrl !== null && baseUrl.trim() !== ""
			? baseUrl.trim()
			: (envBase ?? DEFAULT_BASE_URL);
	return candidate.replace(/\/+$/, "");
}

function buildUsageUrl(baseUrl: string): string {
	const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return `${normalized}${USAGE_PATH}`;
}

function parseResetTime(data: Record<string, unknown>, nowMs: number): number | undefined {
	const timeKeys = ["reset_at", "resetAt", "reset_time", "resetTime"] as const;
	for (const key of timeKeys) {
		const value = data[key];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				const parsed = Date.parse(trimmed);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			return value > 1_000_000_000_000 ? value : value * 1000;
		}
	}

	const secondsKeys = ["reset_in", "resetIn", "ttl", "window"] as const;
	for (const key of secondsKeys) {
		const seconds = toNumber(data[key]);
		if (seconds !== undefined) return nowMs + seconds * 1000;
	}

	return undefined;
}

function formatDurationLabel(duration: number, timeUnit: string): string | undefined {
	const upper = timeUnit.toUpperCase();
	if (upper.includes("MINUTE")) {
		if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
		return `${duration}m limit`;
	}
	if (upper.includes("HOUR")) return `${duration}h limit`;
	if (upper.includes("DAY")) return `${duration}d limit`;
	if (upper.includes("SECOND")) return `${duration}s limit`;
	return undefined;
}

function buildWindow(windowData: Record<string, unknown>, nowMs: number): UsageWindow | undefined {
	const duration = toNumber(windowData.duration);
	const timeUnitValue = windowData.timeUnit;
	const timeUnit = typeof timeUnitValue === "string" ? timeUnitValue : "";
	const label = duration !== undefined && timeUnit !== "" ? formatDurationLabel(duration, timeUnit) : undefined;
	const resetsAt = parseResetTime(windowData, nowMs);

	if (
		duration === undefined &&
		(label === undefined || label === null || label === "") &&
		(resetsAt === undefined || resetsAt === null || resetsAt === 0)
	)
		return undefined;
	let durationMs: number | undefined;
	if (duration !== undefined) {
		const upper = timeUnit.toUpperCase();
		if (upper.includes("MINUTE")) durationMs = duration * 60_000;
		else if (upper.includes("HOUR")) durationMs = duration * 3_600_000;
		else if (upper.includes("DAY")) durationMs = duration * 86_400_000;
		else if (upper.includes("SECOND")) durationMs = duration * 1000;
	}

	return {
		id: duration !== undefined && timeUnit !== "" ? `${duration}${timeUnit.toLowerCase()}` : "default",
		label: label !== undefined && label !== null && label !== "" ? label : "Usage window",
		durationMs,
		resetsAt,
	};
}

function buildUsageRow(data: Record<string, unknown>, defaultLabel: string, nowMs: number): KimiUsageRow | null {
	const limit = toNumber(data.limit);
	let used = toNumber(data.used);
	const remaining = toNumber(data.remaining);
	if (used === undefined && remaining !== undefined && limit !== undefined) {
		used = limit - remaining;
	}

	if (used === undefined && limit === undefined) return null;
	const resetsAt = parseResetTime(data, nowMs);
	return {
		label: getLabelFromData(data, defaultLabel),
		used,
		limit,
		remaining,
		resetsAt,
	};
}

function getLabelFromData(data: Record<string, unknown>, defaultLabel: string): string {
	const name = data.name;
	if (typeof name === "string" && name.length > 0) return name;
	const title = data.title;
	if (typeof title === "string" && title.length > 0) return title;
	return defaultLabel;
}

function buildUsageAmount(row: KimiUsageRow): UsageAmount {
	const amount: UsageAmount = { unit: "unknown" };
	if (row.limit !== undefined) amount.limit = row.limit;
	if (row.used !== undefined) amount.used = row.used;
	if (row.remaining !== undefined) amount.remaining = row.remaining;
	if (row.limit !== undefined && row.used !== undefined && row.limit > 0) {
		amount.usedFraction = Math.min(Math.max(row.used / row.limit, 0), 1);
		amount.remainingFraction = Math.min(Math.max((row.limit - row.used) / row.limit, 0), 1);
		amount.remaining = amount.remaining ?? row.limit - row.used;
	}
	return amount;
}

function buildUsageStatus(amount: UsageAmount): UsageStatus {
	if (amount.usedFraction === undefined) return "unknown";
	if (amount.usedFraction >= 1) return "exhausted";
	if (amount.usedFraction >= 0.9) return "warning";
	return "ok";
}

function toUsageLimit(row: KimiUsageRow, provider: string, index: number, accountId?: string): UsageLimit {
	const window: UsageWindow | undefined =
		row.window ??
		(row.resetsAt !== null && row.resetsAt !== undefined && row.resetsAt !== 0
			? {
					id: "default",
					label: "Usage window",
					resetsAt: row.resetsAt,
				}
			: undefined);

	const amount = buildUsageAmount(row);
	return {
		id: `${provider}:${index}`,
		label: row.label,
		scope: {
			provider,
			accountId,
			windowId: window?.id,
			shared: true,
		},
		window,
		amount,
		status: buildUsageStatus(amount),
	};
}

function parseUsagePayload(payload: unknown, nowMs: number): { rows: KimiUsageRow[]; raw: KimiUsagePayload } | null {
	if (isRecord(payload) === false) return null;
	const data = payload as KimiUsagePayload;
	const rows: KimiUsageRow[] = [];

	if (isRecord(data.usage) === true) {
		const summary = buildUsageRow(data.usage as Record<string, unknown>, "Total quota", nowMs);
		if (summary !== null) rows.push(summary);
	}

	if (Array.isArray(data.limits) === true) {
		(data.limits as unknown[]).forEach((item, idx) => {
			if (isRecord(item) === false) return;
			const itemObj = item as Record<string, unknown>;
			const detail = isRecord(itemObj.detail) ? (itemObj.detail as Record<string, unknown>) : itemObj;
			const windowData = isRecord(itemObj.window) ? (itemObj.window as Record<string, unknown>) : {};
			const label = buildKimiLimitLabel(itemObj, detail, windowData, idx);
			const row = buildUsageRow(detail, label, nowMs);
			if (row !== null) {
				row.window = buildWindow(windowData, nowMs);
				rows.push(row);
			}
		});
	}

	return { rows, raw: data };
}

function buildKimiLimitLabel(
	item: Record<string, unknown>,
	detail: Record<string, unknown>,
	windowData: Record<string, unknown>,
	idx: number,
): string {
	const itemName = item.name;
	if (typeof itemName === "string" && itemName.length > 0) return itemName;
	const itemTitle = item.title;
	if (typeof itemTitle === "string" && itemTitle.length > 0) return itemTitle;
	const itemScope = item.scope;
	if (typeof itemScope === "string" && itemScope.length > 0) return itemScope;
	const detailName = detail.name;
	if (typeof detailName === "string" && detailName.length > 0) return detailName;
	const detailTitle = detail.title;
	if (typeof detailTitle === "string" && detailTitle.length > 0) return detailTitle;

	const duration = toNumber(windowData.duration);
	const timeUnitValue = windowData.timeUnit;
	const timeUnit = typeof timeUnitValue === "string" ? timeUnitValue : "";
	if (duration !== undefined && timeUnit !== "") {
		const durationLabel = formatDurationLabel(duration, timeUnit);
		if (durationLabel !== undefined && durationLabel !== null && durationLabel !== "") return durationLabel;
	}

	return `Limit #${idx + 1}`;
}

export const kimiUsageProvider: UsageProvider = {
	id: "kimi-code",
	supports(params: UsageFetchParams): boolean {
		return params.provider === "kimi-code" && params.credential.type === "oauth";
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "kimi-code") return null;
		const { credential } = params;
		if (credential.type !== "oauth") return null;

		let accessToken = credential.accessToken;
		if (accessToken === null || accessToken === undefined || accessToken === "") return null;

		const nowMs = Date.now();
		if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
			if (
				credential.refreshToken === null ||
				credential.refreshToken === undefined ||
				credential.refreshToken === ""
			) {
				ctx.logger?.warn("Kimi usage token expired, no refresh token", { provider: params.provider });
				return null;
			}
			try {
				ctx.logger?.debug("Kimi usage token expired, refreshing", { provider: params.provider });
				const refreshed = await refreshKimiToken(credential.refreshToken);
				accessToken = refreshed.access;
			} catch (error) {
				ctx.logger?.warn("Kimi usage token refresh failed", { provider: params.provider, error: String(error) });
				return null;
			}
		}

		const baseUrl = normalizeBaseUrl(params.baseUrl);
		const url = buildUsageUrl(baseUrl);
		let payload: unknown;
		try {
			const commonHeaders = await getKimiCommonHeaders();
			const response = await ctx.fetch(url, {
				headers: {
					...commonHeaders,
					Authorization: `Bearer ${accessToken}`,
				},
				signal: params.signal,
			});
			if (response.ok === false) {
				ctx.logger?.warn("Kimi usage request failed", { status: response.status, provider: params.provider });
				return null;
			}
			payload = await response.json();
		} catch (error) {
			ctx.logger?.warn("Kimi usage request error", { provider: params.provider, error: String(error) });
			return null;
		}

		const parsed = parseUsagePayload(payload, nowMs);
		if (parsed === null || parsed.rows.length === 0) {
			ctx.logger?.warn("Kimi usage response invalid", { provider: params.provider });
			return null;
		}

		const limits = parsed.rows.map((row, index) => toUsageLimit(row, params.provider, index, credential.accountId));

		const report: UsageReport = {
			provider: params.provider,
			fetchedAt: nowMs,
			limits,
			metadata: {
				endpoint: url,
			},
			raw: parsed.raw,
		};

		return report;
	},
};
