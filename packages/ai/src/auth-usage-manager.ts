import type { UsageLogger, UsageReport } from "./usage";
import { getUsageReportIdentifiers } from "./auth-usage-utils";

export function mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
	if (reports.length === 1) return reports[0];
	const sorted = [...reports].sort((a, b) => {
		const diff = b.limits.length - a.limits.length;
		if (diff !== 0) return diff;
		return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
	});
	const base = sorted[0];
	const limits = [...base.limits];
	const ids = new Set(limits.map(l => l.id));
	const meta: Record<string, unknown> = { ...base.metadata };
	let fetchedAt = base.fetchedAt;

	for (const r of sorted.slice(1)) {
		fetchedAt = Math.max(fetchedAt, r.fetchedAt);
		for (const l of r.limits) {
			if (!ids.has(l.id)) {
				ids.add(l.id);
				limits.push(l);
			}
		}
		if (r.metadata) {
			for (const [k, v] of Object.entries(r.metadata)) {
				if (meta[k] === undefined) meta[k] = v;
			}
		}
	}
	return { ...base, fetchedAt, limits, metadata: Object.keys(meta).length > 0 ? meta : undefined };
}

export function dedupeUsageReports(reports: UsageReport[], logger?: UsageLogger): UsageReport[] {
	const groups: UsageReport[][] = [];
	const idToGroup = new Map<string, number>();

	for (const r of reports) {
		const ids = getUsageReportIdentifiers(r);
		let groupIdx: number | undefined;
		for (const id of ids) {
			const existing = idToGroup.get(id);
			if (existing !== undefined) {
				groupIdx = existing;
				break;
			}
		}
		if (groupIdx === undefined) {
			groupIdx = groups.length;
			groups.push([]);
		}
		groups[groupIdx].push(r);
		for (const id of ids) idToGroup.set(id, groupIdx);
	}

	const deduped = groups.map(g => mergeUsageReportGroup(g));
	if (deduped.length !== reports.length) {
		logger?.debug("Usage reports deduped", { before: reports.length, after: deduped.length });
	}
	return deduped;
}
