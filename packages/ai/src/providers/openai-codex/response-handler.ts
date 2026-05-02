import { toNumber } from "../../utils";

export type CodexRateLimit = {
	used_percent?: number;
	window_minutes?: number;
	resets_at?: number;
};

export type CodexRateLimits = {
	primary?: CodexRateLimit;
	secondary?: CodexRateLimit;
};

export type CodexErrorInfo = {
	message: string;
	status: number;
	friendlyMessage?: string;
	rateLimits?: CodexRateLimits;
	raw?: string;
};

export async function parseCodexError(response: Response): Promise<CodexErrorInfo> {
	const raw = await response.text();
	const message = getInitialErrorMessage(raw, response.statusText);
	let friendlyMessage: string | undefined;
	let rateLimits: CodexRateLimits | undefined;
	let finalMessage = message;

	try {
		const parsed = JSON.parse(raw) as { error?: Record<string, unknown> };
		const err = parsed?.error ?? {};

		const headers = response.headers;
		const primary = {
			used_percent: toNumber(headers.get("x-codex-primary-used-percent")),
			window_minutes: toInt(headers.get("x-codex-primary-window-minutes")),
			resets_at: toInt(headers.get("x-codex-primary-reset-at")),
		};
		const secondary = {
			used_percent: toNumber(headers.get("x-codex-secondary-used-percent")),
			window_minutes: toInt(headers.get("x-codex-secondary-window-minutes")),
			resets_at: toInt(headers.get("x-codex-secondary-reset-at")),
		};
		rateLimits =
			primary.used_percent !== undefined || secondary.used_percent !== undefined
				? { primary, secondary }
				: undefined;

		const errorDetails = err as {
			code?: string;
			type?: string;
			resets_at?: number;
			plan_type?: string;
			message?: string;
		};
		const code = String(errorDetails.code ?? errorDetails.type ?? "");
		const resetsAt = errorDetails.resets_at ?? primary.resets_at ?? secondary.resets_at;
		const mins =
			resetsAt !== null && resetsAt !== undefined && resetsAt !== 0
				? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000))
				: undefined;

		friendlyMessage = getFriendlyMessage(code, errorDetails.plan_type, mins, response.status);

		finalMessage = errorDetails.message ?? friendlyMessage ?? message;
	} catch {
		// raw body not JSON
	}

	return {
		message: finalMessage,
		status: response.status,
		friendlyMessage,
		rateLimits,
		raw,
	};
}

function getInitialErrorMessage(raw: string, statusText: string): string {
	if (raw.length > 0) return raw;
	if (statusText.length > 0) return statusText;
	return "Request failed";
}

function getFriendlyMessage(
	code: string,
	planType: string | undefined,
	mins: number | undefined,
	status: number,
): string | undefined {
	const when = mins === undefined ? "" : ` Try again in ~${mins} min.`;
	if (/usage_limit_reached|usage_not_included/i.test(code)) {
		const plan =
			planType !== null && planType !== undefined && planType !== "" ? ` (${planType.toLowerCase()} plan)` : "";
		return `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
	}
	if (/rate_limit_exceeded/i.test(code) || status === 429) {
		return `ChatGPT rate limit exceeded.${when}`.trim();
	}
	return undefined;
}

function toInt(v: string | null): number | undefined {
	if (v === null) return undefined;
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}
