#!/usr/bin/env bun
/**
 * Programmatic lint-fix using oxlint JSON output and targeted line-based edits.
 * Uses (line, column) coordinates rather than byte offsets to avoid UTF-8 issues.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Span {
	offset: number;
	length: number;
	line: number;
	column: number;
}

interface Diagnostic {
	message: string;
	code: string;
	severity: "error" | "warning";
	filename: string;
	labels: { span: Span }[];
}

interface OxlintReport {
	diagnostics: Diagnostic[];
}

const SKIP_FILES = new Set([
	"packages/coding-agent/src/export/html/template.generated.ts",
]);

function runOxlint(target: string): Diagnostic[] {
	const result = spawnSync("bunx", ["oxlint", "--format", "json", "--no-error-on-unmatched-pattern", target], {
		encoding: "utf8",
		maxBuffer: 200 * 1024 * 1024,
	});
	const output = result.stdout || "";
	if (!output.trim().startsWith("{")) return [];
	try {
		return (JSON.parse(output) as OxlintReport).diagnostics ?? [];
	} catch {
		return [];
	}
}

const isIdent = (s: string) => /^[A-Za-z_$#][\w$]*$/.test(s);
const isPropAccess = (s: string) => /^[A-Za-z_$][\w$]*(\?\.|\.)[#\w$.?]+$/.test(s);
const isCallOrIndex = (s: string) => /^[A-Za-z_$#][#\w$.?]*(\([^()]*\)|\[[^[\]]*\])$/.test(s);
const isParenthesized = (s: string) => /^\([^()]*\)$/.test(s);

function isFixableExpr(s: string): boolean {
	const t = s.trim();
	return isIdent(t) || isPropAccess(t) || isCallOrIndex(t) || isParenthesized(t);
}

interface FixResult {
	newLine: string;
}

function fixStrictBoolean(
	line: string,
	column: number,
	length: number,
	kind: "string" | "number" | "boolean" | "any" | "enum",
): FixResult | null {
	const ci = column - 1;
	if (ci < 0 || ci + length > line.length) return null;
	const expr = line.slice(ci, ci + length);
	if (!isFixableExpr(expr)) return null;

	const exprT = expr.trim();
	const before = line.slice(0, ci);
	const after = line.slice(ci + length);

	// Detect double-negation `!!x` — leave it alone (we can't know the right transformation).
	if (/!!\s*$/.test(before)) return null;

	// Detect a recently-applied transformation around (e.g. `(x !== undefined && ` already there)
	if (/&& \s*$/.test(before) || /\|\| \s*$/.test(before)) return null;

	// Detect `x || default` defaulting pattern — convert to `x ?? default` instead.
	const orMatch = /^\s*\|\|\s*/.exec(after);
	if (orMatch) {
		// Only safe to convert to ?? for primitives (string/number/boolean/enum).
		// For "any", we don't know if both sides are compatible.
		if (kind === "string" || kind === "number" || kind === "boolean" || kind === "enum") {
			const newAfter = after.replace(/^\s*\|\|/, " ??");
			return { newLine: before + exprT + newAfter };
		}
	}

	// If the expr appears to feed a non-conditional context (e.g. `const x = expr || 0`),
	// converting to a boolean check breaks the value-using flow. Detect by checking
	// whether the immediate parent is an `if (`, `while (`, ternary `?`, etc.
	// Heuristic: skip transformation if the expression is on an assignment RHS without
	// a clear boolean context.
	const stripped = before.trimEnd();
	const isInBooleanContext =
		stripped.endsWith("if (") ||
		stripped.endsWith("while (") ||
		stripped.endsWith("&&") ||
		stripped.endsWith("||") ||
		stripped.endsWith("(") ||
		stripped.endsWith(",") ||
		stripped.endsWith("return") ||
		stripped.endsWith("=>") ||
		stripped.endsWith("=") ||
		/[?&|!]$/.test(stripped) ||
		stripped === "";
	// In ternary RHS-of-?: positions, the rule still fires; allow those.
	const followsCondMarkerAfter = /^\s*\?/.test(after) || /^\s*:/.test(after);

	if (!isInBooleanContext && !followsCondMarkerAfter) {
		return null;
	}

	const negated = /!\s*$/.test(before);

	let replacement: string;
	if (kind === "string") {
		replacement = negated
			? `(${exprT} === null || ${exprT} === undefined || ${exprT} === "")`
			: `(${exprT} !== null && ${exprT} !== undefined && ${exprT} !== "")`;
	} else if (kind === "number") {
		replacement = negated
			? `(${exprT} === null || ${exprT} === undefined || ${exprT} === 0)`
			: `(${exprT} !== null && ${exprT} !== undefined && ${exprT} !== 0)`;
	} else if (kind === "boolean") {
		replacement = negated ? `(${exprT} !== true)` : `(${exprT} === true)`;
	} else if (kind === "enum") {
		replacement = negated
			? `(${exprT} === null || ${exprT} === undefined)`
			: `(${exprT} !== null && ${exprT} !== undefined)`;
	} else {
		replacement = negated
			? `(${exprT} === null || ${exprT} === undefined)`
			: `(${exprT} !== null && ${exprT} !== undefined)`;
	}

	if (negated) {
		const m = /(.*?)(!)\s*$/.exec(before);
		if (!m) return null;
		return { newLine: m[1] + replacement + after };
	}
	return { newLine: before + replacement + after };
}

function fixTemplateExpression(line: string, column: number, length: number): FixResult | null {
	const ci = column - 1;
	if (ci < 0 || ci + length > line.length) return null;
	const expr = line.slice(ci, ci + length);
	if (!isFixableExpr(expr)) return null;
	const before = line.slice(0, ci);
	const after = line.slice(ci + length);
	if (/String\($/.test(before)) return null;
	return { newLine: before + `String(${expr.trim()})` + after };
}

function fixUselessReturn(line: string, column: number, length: number): FixResult | null {
	const ci = column - 1;
	if (ci < 0 || ci + length > line.length) return null;
	const expr = line.slice(ci, ci + length);
	if (expr !== "return;" && expr.trim() !== "return;") return null;
	const before = line.slice(0, ci);
	// Only remove if line was effectively just whitespace + return;
	if (!/^\s*$/.test(before)) return null;
	return { newLine: "" };
}

function fixNonNullAssertion(line: string, column: number, length: number): FixResult | null {
	const ci = column - 1;
	if (ci < 0 || ci + length > line.length) return null;
	const expr = line.slice(ci, ci + length);
	const before = line.slice(0, ci);
	const after = line.slice(ci + length);

	if (!expr.endsWith("!")) return null;
	const inner = expr.slice(0, -1).trimEnd();
	if (inner === "") return null;

	const next = after[0];
	if (next === ".") {
		return { newLine: before + inner + "?" + after };
	}
	if (next === "[") {
		return { newLine: before + inner + "?." + after };
	}
	if (next === "(") {
		return { newLine: before + inner + after };
	}
	return null;
}

function processFile(filename: string, diags: Diagnostic[]): boolean {
	if (SKIP_FILES.has(filename)) return false;
	let text: string;
	try {
		text = readFileSync(filename, "utf8");
	} catch {
		return false;
	}

	const lines = text.split("\n");
	let modified = false;

	const sorted = [...diags].sort((a, b) => {
		const al = a.labels[0]?.span.line ?? 0;
		const bl = b.labels[0]?.span.line ?? 0;
		if (al !== bl) return bl - al;
		const ac = a.labels[0]?.span.column ?? 0;
		const bc = b.labels[0]?.span.column ?? 0;
		return bc - ac;
	});

	// Track which lines have already been modified to prevent amplification
	// when multiple diagnostics target the same line.
	const modifiedLines = new Set<number>();

	for (const d of sorted) {
		if (d.labels.length === 0) continue;
		const span = d.labels[0].span;
		const lineIdx = span.line - 1;
		if (lineIdx < 0 || lineIdx >= lines.length) continue;
		// Skip if this line has already been modified — re-application can amplify.
		if (modifiedLines.has(lineIdx)) continue;
		const lineText = lines[lineIdx];

		let result: FixResult | null = null;

		if (d.code === "typescript-eslint(strict-boolean-expressions)") {
			let kind: "string" | "number" | "boolean" | "any" | "enum" | null = null;
			if (d.message.includes("nullable string")) kind = "string";
			else if (d.message.includes("nullable number")) kind = "number";
			else if (d.message.includes("nullable boolean")) kind = "boolean";
			else if (d.message.includes("nullable enum")) kind = "enum";
			else if (d.message.includes("any value")) kind = "any";
			if (kind !== null) {
				result = fixStrictBoolean(lineText, span.column, span.length, kind);
			}
		} else if (d.code === "typescript-eslint(restrict-template-expressions)") {
			result = fixTemplateExpression(lineText, span.column, span.length);
		} else if (d.code === "typescript-eslint(no-non-null-assertion)") {
			result = fixNonNullAssertion(lineText, span.column, span.length);
		} else if (d.code === "eslint(no-useless-return)") {
			result = fixUselessReturn(lineText, span.column, span.length);
		}

		if (result && result.newLine !== lineText) {
			lines[lineIdx] = result.newLine;
			modifiedLines.add(lineIdx);
			modified = true;
		}
	}

	if (modified) {
		writeFileSync(filename, lines.join("\n"));
	}

	return modified;
}

function fixCatchRedeclarations(filename: string): boolean {
	if (SKIP_FILES.has(filename)) return false;
	let text: string;
	try {
		text = readFileSync(filename, "utf8");
	} catch {
		return false;
	}
	let changed = false;
	const re = /catch\s*\(\s*(error|err|e)\s*\)\s*\{/g;
	let m: RegExpExecArray | null;
	const replacements: { start: number; end: number; replacement: string }[] = [];
	while ((m = re.exec(text)) !== null) {
		const paramName = m[1];
		const blockStart = m.index + m[0].length;
		let depth = 1;
		let i = blockStart;
		while (i < text.length && depth > 0) {
			const c = text[i];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			if (depth === 0) break;
			i++;
		}
		const blockEnd = i;
		const block = text.slice(blockStart, blockEnd);
		const innerDecl = new RegExp(`\\bconst\\s+${paramName}\\b`);
		if (!innerDecl.test(block)) continue;
		const newBlock = block.replace(new RegExp(`\\b${paramName}\\b`, "g"), "message");
		if (newBlock !== block) {
			replacements.push({ start: blockStart, end: blockEnd, replacement: newBlock });
		}
	}
	if (replacements.length === 0) return false;
	replacements.sort((a, b) => b.start - a.start);
	let out = text;
	for (const r of replacements) {
		out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
		changed = true;
	}
	if (changed) writeFileSync(filename, out);
	return changed;
}

function main() {
	const target = process.argv[2] ?? "packages";
	console.log(`Running oxlint on ${target}...`);
	const diags = runOxlint(target);
	console.log(`Found ${diags.length} diagnostics`);

	const byFile = new Map<string, Diagnostic[]>();
	for (const d of diags) {
		const arr = byFile.get(d.filename) ?? [];
		arr.push(d);
		byFile.set(d.filename, arr);
	}

	let modified = 0;
	for (const [filename, fileDiags] of byFile) {
		const a = processFile(filename, fileDiags);
		const b = fixCatchRedeclarations(filename);
		if (a || b) modified++;
	}

	console.log(`Modified ${modified} files`);
}

main();
