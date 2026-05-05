import type { Provider } from "./types";
import type { UsageCredential, UsageLimit, UsageProvider, UsageReport } from "./usage";
import { kimiUsageProvider } from "./usage/kimi";
import { minimaxCodeUsageProvider } from "./usage/minimax-code";
import { openaiCodexUsageProvider } from "./usage/openai-codex";
import { zaiUsageProvider } from "./usage/zai";

/**
 * Descriptor for a single usage-report request: a provider + credential pair plus
 * an optional base URL. Lacks the per-call `signal` carried by `UsageFetchParams`,
 * so the same descriptor can be cached, deduped, and replayed under fresh timeouts.
 */
export interface UsageRequestDescriptor {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
}

const DEFAULT_USAGE_PROVIDERS: UsageProvider[] = [
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	zaiUsageProvider,
];

/**
 * Default map of provider id → usage fetcher. Built from the providers that
 * actually ship in this repo. Anthropic/Claude and Google/Antigravity entries
 * were intentionally pruned (commit 2da77ade7) and must not be re-added without
 * an explicit ask.
 */
export const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(DEFAULT_USAGE_PROVIDERS.map(p => [p.id, p]));

export function isFractionUsageExhausted(am: { usedFraction?: number; remainingFraction?: number }): boolean {
	if (am.usedFraction !== undefined && am.usedFraction >= 1) return true;
	if (am.remainingFraction !== undefined && am.remainingFraction <= 0) return true;
	return false;
}

export function isAbsoluteUsageExhausted(am: {
	used?: number;
	limit?: number;
	remaining?: number;
	unit?: string;
}): boolean {
	if (am.used !== undefined && am.limit !== undefined && am.used >= am.limit) return true;
	if (am.remaining !== undefined && am.remaining <= 0) return true;
	if (am.unit === "percent" && am.used !== undefined && am.used >= 100) return true;
	return false;
}

export function isUsageLimitExhausted(limit: UsageLimit): boolean {
	if (limit.status === "exhausted") return true;
	const am = limit.amount;
	if (isFractionUsageExhausted(am)) return true;
	if (isAbsoluteUsageExhausted(am)) return true;
	return false;
}

export function isUsageLimitReached(report: UsageReport): boolean {
	return report.limits.some(l => isUsageLimitExhausted(l));
}

export function getUsageResetAtMs(report: UsageReport, nowMs: number): number | undefined {
	const res = report.limits
		.filter(l => isUsageLimitExhausted(l))
		.map(l => l.window?.resetsAt)
		.filter((r): r is number => typeof r === "number" && r > nowMs);
	return res.length > 0 ? Math.min(...res) : undefined;
}

export function getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
	const val = report.metadata?.[key];
	return typeof val === "string" ? val.trim() : undefined;
}

export function getUsageReportScopeAccountId(report: UsageReport): string | undefined {
	const ids = new Set<string>();
	for (const l of report.limits) {
		const id = l.scope.accountId?.trim();
		if (id !== undefined && id !== "") ids.add(id);
	}
	return ids.size === 1 ? Array.from(ids)[0] : undefined;
}

export function getUsageReportIdentifiers(report: UsageReport): string[] {
	const ids: string[] = [];
	const email = getUsageReportMetadataValue(report, "email");
	if (email !== undefined && email !== "") ids.push(`email:${email.toLowerCase()}`);
	if (report.provider !== "openai-codex") {
		const acc =
			getUsageReportMetadataValue(report, "accountId") ??
			getUsageReportMetadataValue(report, "account") ??
			getUsageReportMetadataValue(report, "user") ??
			getUsageReportMetadataValue(report, "username") ??
			getUsageReportScopeAccountId(report);
		if (acc !== undefined && acc !== "") ids.push(`account:${acc}`);
	}
	return ids.map(id => `${report.provider}:${id.toLowerCase()}`);
}
