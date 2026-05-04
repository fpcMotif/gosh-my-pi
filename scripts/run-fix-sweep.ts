#!/usr/bin/env bun
/**
 * Lint-fix sweep orchestrator.
 *
 * Runs the kept fix-*.ts codemods in dependency order, captures lint counts
 * before/after, and refuses to land any step that grew the total or broke
 * `tsgo --noEmit` in a touched package.
 *
 * Order matters:
 *   1. fix-or-defaulting          — collapse safe `(x !== null && x !== undefined) || N` -> `x ?? N`
 *   2. fix-null-checks            — `(x != null)` -> `(x !== null && x !== undefined)`  (eqeqeq)
 *   3. fix-await-loop-stop-close  — narrow await-in-loop fix for `.stop()`/`.close()` patterns
 *   4. fix-signal-aborted         — `.aborted` boolean checks
 *   5. fix-amplification          — final cleanup of cascade artifacts from prior runs
 *
 * Usage:
 *   bun scripts/run-fix-sweep.ts             # full sweep
 *   bun scripts/run-fix-sweep.ts --dry-run   # report what would run; no script execution
 *   bun scripts/run-fix-sweep.ts --no-validate  # skip per-step tsgo validation
 *   bun scripts/run-fix-sweep.ts --abort-on-grow=false  # keep going even if a step grows the count
 *
 * Exit codes:
 *   0 — sweep completed and total did not grow
 *   1 — a step grew the total (or tsgo failed) and --abort-on-grow is on
 *   2 — a script crashed (non-zero exit code)
 */

import { captureLintTotals, type CodemodResult, runCodemod, validateChangedFiles } from "./lib/codemod-runner";

interface SweepStep {
	name: string;
	script: string;
	expects: string;
}

const PIPELINE: SweepStep[] = [
	{
		name: "or-defaulting",
		script: "scripts/fix-or-defaulting.ts",
		expects: "collapses safe `(x !== null && x !== undefined) || N` to `x ?? N`",
	},
	{
		name: "null-checks",
		script: "scripts/fix-null-checks.ts",
		expects: "rewrites `(x != null)` / `(x == null)` to explicit pairs (eqeqeq)",
	},
	{
		name: "await-loop-stop-close",
		script: "scripts/fix-await-loop-stop-close.ts",
		expects: "for-of loop with `await x.stop()` / `.close()` -> `Promise.all(...)`",
	},
	{
		name: "signal-aborted",
		script: "scripts/fix-signal-aborted.ts",
		expects: "narrow `.aborted` boolean check rewrites",
	},
	{
		name: "amplification",
		script: "scripts/fix-amplification.ts",
		expects: "final cleanup of cascaded `=== true) === true)` and amplified expressions",
	},
];

function pad(n: number): string {
	return String(n).padStart(5);
}

function fmtDelta(d: number): string {
	if (d > 0) return `+${d}`;
	return String(d);
}

function summarize(result: CodemodResult): void {
	const exitTag = result.exitCode === 0 ? "ok" : `exit=${result.exitCode}`;
	const filesTag = `${result.modifiedFiles.length} file(s)`;
	const ms = `${result.durationMs}ms`;
	console.log(`  -> ${result.name}: ${exitTag}, ${filesTag} touched, ${ms}`);
	if (result.exitCode !== 0) {
		console.log("     stdout:");
		for (const line of result.stdout.split("\n").slice(0, 20)) console.log(`       ${line}`);
		console.log("     stderr:");
		for (const line of result.stderr.split("\n").slice(0, 20)) console.log(`       ${line}`);
	}
}

async function main(): Promise<void> {
	const args = new Set(Bun.argv.slice(2));
	const dryRun = args.has("--dry-run");
	const noValidate = args.has("--no-validate");
	const abortOnGrow = !args.has("--abort-on-grow=false");

	console.log("Lint-fix sweep orchestrator");
	console.log("===========================");
	if (dryRun) {
		console.log("(dry run — listing steps only)");
		for (const step of PIPELINE) console.log(`  - ${step.name}: ${step.script}\n      ${step.expects}`);
		return;
	}

	console.log("Capturing baseline lint totals…");
	const baseline = await captureLintTotals();
	console.log(`  baseline: ${pad(baseline.errors)} err  ${pad(baseline.warnings)} warn  (total ${baseline.total})`);

	const allModified = new Set<string>();
	let lastTotals = baseline;

	for (const step of PIPELINE) {
		console.log(`\nRunning ${step.name}…`);
		const result = await runCodemod(step.script);
		summarize(result);
		if (result.exitCode !== 0) {
			console.error(`\nFATAL: ${step.name} crashed. Aborting.`);
			process.exit(2);
		}
		for (const f of result.modifiedFiles) allModified.add(f);
		if (!noValidate && result.modifiedFiles.length > 0) {
			console.log(`     validating types in ${result.modifiedFiles.length} touched file(s)…`);
			const v = await validateChangedFiles(result.modifiedFiles);
			if (!v.ok) {
				console.error(`     tsgo failed for: ${v.failingFiles.join(", ")}`);
				console.error(v.output.slice(0, 2000));
				if (abortOnGrow) {
					console.error("\nFATAL: types broken after this step. Aborting.");
					process.exit(1);
				}
			}
		}
		const after = await captureLintTotals();
		const delta = after.total - lastTotals.total;
		console.log(
			`     lint after step: ${pad(after.errors)} err  ${pad(after.warnings)} warn  (Δ ${fmtDelta(delta)})`,
		);
		if (delta > 0 && abortOnGrow) {
			console.error(`\nFATAL: ${step.name} grew the total by ${delta}. Aborting.`);
			process.exit(1);
		}
		lastTotals = after;
	}

	const finalDelta = lastTotals.total - baseline.total;
	console.log("\nSweep complete.");
	console.log(`  baseline: ${pad(baseline.errors)} err  ${pad(baseline.warnings)} warn  (total ${baseline.total})`);
	console.log(
		`  final:    ${pad(lastTotals.errors)} err  ${pad(lastTotals.warnings)} warn  (total ${lastTotals.total})`,
	);
	console.log(`  Δ total: ${fmtDelta(finalDelta)}`);
	console.log(`  files touched across all steps: ${allModified.size}`);

	if (finalDelta > 0) {
		console.error("\nWARNING: sweep ended with a higher total than baseline. Investigate before committing.");
		if (abortOnGrow) process.exit(1);
	}
}

await main();
