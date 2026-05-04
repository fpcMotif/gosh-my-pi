/**
 * Shared harness for the lint-fix codemod orchestrator.
 *
 * Provides:
 *   - runCodemod(scriptPath): spawns a fix script and reports back which
 *     working-tree files it modified (via `git diff --name-only` deltas)
 *   - captureLintTotals(): runs oxlint --format json and returns
 *     { errors, warnings, total } so the orchestrator can verify each
 *     step actually moved the count
 *   - validateChangedFiles(files): runs `tsgo --noEmit` against the
 *     packages owning those files. Returns { ok, output } so the
 *     orchestrator can refuse to land a step that broke types.
 *
 * Scripts run unchanged — the harness wraps execution rather than rewriting
 * each fix-*.ts. This keeps the consolidation low-risk; future codemods can
 * be authored to fit this contract directly.
 */

import { $ } from "bun";

export interface CodemodResult {
	name: string;
	scriptPath: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	modifiedFiles: string[];
}

export interface LintTotals {
	errors: number;
	warnings: number;
	total: number;
}

export interface ValidationResult {
	ok: boolean;
	failingFiles: string[];
	output: string;
}

interface OxlintDiagnostic {
	severity: "error" | "warning";
}

interface OxlintReport {
	diagnostics: OxlintDiagnostic[];
}

async function listDirtyFiles(): Promise<Set<string>> {
	const out = await $`git diff --name-only HEAD`.quiet().nothrow().text();
	const files = out
		.trim()
		.split("\n")
		.filter(l => l.length > 0);
	return new Set(files);
}

function diffSets(current: Set<string>, baseline: Set<string>): string[] {
	const added: string[] = [];
	for (const file of current) {
		if (!baseline.has(file)) added.push(file);
	}
	return added;
}

export async function runCodemod(scriptPath: string): Promise<CodemodResult> {
	const startTime = Date.now();
	const baselineFiles = await listDirtyFiles();
	const proc = Bun.spawn(["bun", scriptPath], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const afterFiles = await listDirtyFiles();
	const modifiedFiles = diffSets(afterFiles, baselineFiles);
	const name = scriptPath.split("/").at(-1) ?? scriptPath;
	return {
		name,
		scriptPath,
		exitCode: proc.exitCode ?? -1,
		stdout,
		stderr,
		durationMs: Date.now() - startTime,
		modifiedFiles,
	};
}

export async function captureLintTotals(): Promise<LintTotals> {
	const proc = Bun.spawn(["bunx", "oxlint", "--format", "json", "--no-error-on-unmatched-pattern", "packages"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	const trimmed = stdout.trim();
	if (trimmed.length === 0 || !trimmed.startsWith("{")) return { errors: 0, warnings: 0, total: 0 };
	const parsed = JSON.parse(trimmed) as OxlintReport;
	let errors = 0;
	let warnings = 0;
	for (const diag of parsed.diagnostics ?? []) {
		if (diag.severity === "error") errors += 1;
		else warnings += 1;
	}
	return { errors, warnings, total: errors + warnings };
}

/**
 * Group changed files by their owning package and run `tsgo --noEmit -p` on
 * each package's tsconfig. Returns ok=true only if every package passes.
 *
 * If a changed file is outside any `packages/<name>/` (e.g. repo-root config),
 * it is skipped here — the orchestrator should re-run the global lint pass
 * to catch those.
 */
export async function validateChangedFiles(files: string[]): Promise<ValidationResult> {
	const packages = new Set<string>();
	for (const file of files) {
		const match = /^packages\/([^/]+)\//.exec(file);
		if (match !== null) packages.add(match[1]);
	}
	if (packages.size === 0) return { ok: true, failingFiles: [], output: "(no in-package changes to validate)" };
	const failingFiles: string[] = [];
	const outputs: string[] = [];
	for (const pkg of packages) {
		const tsconfig = `packages/${pkg}/tsconfig.json`;
		const result = await $`bunx tsgo --noEmit -p ${tsconfig}`.quiet().nothrow();
		const text = `${result.stdout.toString()}\n${result.stderr.toString()}`;
		outputs.push(`-- ${pkg} --\n${text}`);
		if (result.exitCode !== 0) {
			for (const file of files) {
				if (file.startsWith(`packages/${pkg}/`)) failingFiles.push(file);
			}
		}
	}
	return { ok: failingFiles.length === 0, failingFiles, output: outputs.join("\n") };
}
