#!/usr/bin/env bun
/**
 * Lint snapshot tracker for the lint+fmt sweep.
 *
 * Runs oxlint with JSON output, summarizes the diagnostics, and appends one
 * JSONL line to .lint-history.jsonl so progress between fix runs is visible.
 *
 * Usage:
 *   bun scripts/lint-snapshot.ts             # snapshot, print summary, append history
 *   bun scripts/lint-snapshot.ts --no-write  # snapshot only, do not append
 *   bun scripts/lint-snapshot.ts --diff      # diff against previous snapshot
 *
 * History file is gitignored. Contract is defined by the LintSnapshot
 * interface below; consumers should treat unknown fields as additive.
 */

import * as fs from "node:fs/promises";
import { $ } from "bun";

interface OxlintSpan {
	offset: number;
	length: number;
	line: number;
	column: number;
}

interface OxlintDiagnostic {
	message: string;
	code?: string;
	severity: "error" | "warning";
	filename: string;
	labels: { span: OxlintSpan }[];
}

const RULE_CODE_RE = /^[^()]+\(([^()]+)\)$/;

function normalizeRuleCode(code: string | undefined): string {
	if (code === undefined || code.length === 0) return "<parser>";
	const match = RULE_CODE_RE.exec(code);
	return match !== null ? match[1] : code;
}

interface OxlintReport {
	diagnostics: OxlintDiagnostic[];
}

interface RuleCounts {
	errors: number;
	warnings: number;
}

interface FileCounts extends RuleCounts {
	file: string;
}

interface LintSnapshot {
	ts: string;
	gitSha: string;
	gitDirty: boolean;
	totalErrors: number;
	totalWarnings: number;
	uniqueFiles: number;
	activeRuleCount: number;
	perRule: Record<string, RuleCounts>;
	topFiles: FileCounts[];
}

const HISTORY_FILE = ".lint-history.jsonl";
const TARGETS = ["packages"];
const TOP_FILES = 10;
const TOP_RULES_IN_SUMMARY = 12;

async function captureDiagnostics(): Promise<OxlintDiagnostic[]> {
	const proc = Bun.spawn(["bunx", "oxlint", "--format", "json", "--no-error-on-unmatched-pattern", ...TARGETS], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	const trimmed = stdout.trim();
	if (trimmed.length === 0 || !trimmed.startsWith("{")) return [];
	const parsed = JSON.parse(trimmed) as OxlintReport;
	return parsed.diagnostics ?? [];
}

function tallyDiagnostics(diagnostics: OxlintDiagnostic[]): {
	perRule: Record<string, RuleCounts>;
	perFile: Map<string, RuleCounts>;
	totalErrors: number;
	totalWarnings: number;
} {
	const perRule: Record<string, RuleCounts> = {};
	const perFile = new Map<string, RuleCounts>();
	let totalErrors = 0;
	let totalWarnings = 0;
	for (const diag of diagnostics) {
		const rule = normalizeRuleCode(diag.code);
		const file = diag.filename;
		const isError = diag.severity === "error";
		const ruleBucket = perRule[rule] ?? { errors: 0, warnings: 0 };
		const fileBucket = perFile.get(file) ?? { errors: 0, warnings: 0 };
		if (isError) {
			ruleBucket.errors += 1;
			fileBucket.errors += 1;
			totalErrors += 1;
		} else {
			ruleBucket.warnings += 1;
			fileBucket.warnings += 1;
			totalWarnings += 1;
		}
		perRule[rule] = ruleBucket;
		perFile.set(file, fileBucket);
	}
	return { perRule, perFile, totalErrors, totalWarnings };
}

function topByTotal<T extends RuleCounts>(items: T[], limit: number): T[] {
	return items
		.slice()
		.sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings))
		.slice(0, limit);
}

async function getGitState(): Promise<{ sha: string; dirty: boolean }> {
	const sha = (await $`git rev-parse --short HEAD`.quiet().nothrow().text()).trim();
	const status = (await $`git status --porcelain`.quiet().nothrow().text()).trim();
	return { sha, dirty: status.length > 0 };
}

function buildSnapshot(diagnostics: OxlintDiagnostic[], git: { sha: string; dirty: boolean }): LintSnapshot {
	const tally = tallyDiagnostics(diagnostics);
	const topFiles = topByTotal(
		[...tally.perFile.entries()].map(([file, counts]) => ({ file, ...counts })),
		TOP_FILES,
	);
	return {
		ts: new Date().toISOString(),
		gitSha: git.sha,
		gitDirty: git.dirty,
		totalErrors: tally.totalErrors,
		totalWarnings: tally.totalWarnings,
		uniqueFiles: tally.perFile.size,
		activeRuleCount: Object.keys(tally.perRule).length,
		perRule: tally.perRule,
		topFiles,
	};
}

function printSummary(snap: LintSnapshot, prev: LintSnapshot | null): void {
	const dirtyTag = snap.gitDirty ? "-dirty" : "";
	const totalDelta =
		prev !== null ? snap.totalErrors + snap.totalWarnings - (prev.totalErrors + prev.totalWarnings) : 0;
	const deltaStr = prev !== null ? ` (Δ ${totalDelta >= 0 ? "+" : ""}${totalDelta} vs ${prev.gitSha})` : "";
	console.log(`Snapshot @ ${snap.ts} (${snap.gitSha}${dirtyTag})${deltaStr}`);
	console.log(
		`  errors:    ${snap.totalErrors}${prev !== null ? ` (Δ ${signed(snap.totalErrors - prev.totalErrors)})` : ""}`,
	);
	console.log(
		`  warnings:  ${snap.totalWarnings}${prev !== null ? ` (Δ ${signed(snap.totalWarnings - prev.totalWarnings)})` : ""}`,
	);
	console.log(`  files:     ${snap.uniqueFiles}`);
	console.log(`  rules hit: ${snap.activeRuleCount}`);
	const topRules = Object.entries(snap.perRule)
		.map(([rule, counts]) => ({ rule, ...counts }))
		.sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings))
		.slice(0, TOP_RULES_IN_SUMMARY);
	console.log("Top rules:");
	for (const entry of topRules) {
		const prevEntry = prev?.perRule[entry.rule];
		const ruleDelta =
			prevEntry !== undefined ? entry.errors + entry.warnings - (prevEntry.errors + prevEntry.warnings) : 0;
		const ruleDeltaStr = prevEntry !== undefined ? ` (Δ ${signed(ruleDelta)})` : "";
		console.log(
			`  ${entry.rule.padEnd(40)} ${String(entry.errors).padStart(4)} err  ${String(entry.warnings).padStart(4)} warn${ruleDeltaStr}`,
		);
	}
	console.log("Top files:");
	for (const f of snap.topFiles) {
		console.log(`  ${f.file.padEnd(70)} ${String(f.errors).padStart(4)} err  ${String(f.warnings).padStart(4)} warn`);
	}
}

function signed(n: number): string {
	if (n > 0) return `+${n}`;
	return String(n);
}

async function readPreviousSnapshot(): Promise<LintSnapshot | null> {
	try {
		const text = await Bun.file(HISTORY_FILE).text();
		const lines = text.split("\n").filter(l => l.trim().length > 0);
		if (lines.length === 0) return null;
		return JSON.parse(lines.at(-1) ?? "{}") as LintSnapshot;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function appendHistory(snap: LintSnapshot): Promise<void> {
	const line = `${JSON.stringify(snap)}\n`;
	await fs.appendFile(HISTORY_FILE, line, "utf8");
}

async function main(): Promise<void> {
	const args = new Set(Bun.argv.slice(2));
	const noWrite = args.has("--no-write");
	const wantDiff = args.has("--diff");
	const [diagnostics, git, prev] = await Promise.all([captureDiagnostics(), getGitState(), readPreviousSnapshot()]);
	const snap = buildSnapshot(diagnostics, git);
	printSummary(snap, wantDiff ? prev : null);
	if (!noWrite) {
		await appendHistory(snap);
		console.log(`Appended to ${HISTORY_FILE}`);
	}
}

await main();
