#!/usr/bin/env bun
/**
 * Detect and unwrap exponentially-amplified expressions created by an
 * earlier buggy lint-fix run. Patterns:
 *   ((((... === true) === true) === true) ...)
 *   ((((... !== undefined && ... !== "") !== undefined && ...) ...)
 *
 * For these, we collapse back to the original innermost expression and
 * leave it as `EXPR === true` (or `EXPR !== undefined && EXPR !== ""`)
 * — usually a single check is what was originally intended.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

const files = execSync(
	`rg -l ' === true\\) === true\\)| !== "" \\) !== ""\\)| !== 0\\) !== 0\\)' packages --type ts -0`,
	{ encoding: "buffer" },
)
	.toString("utf8")
	.split("\0")
	.filter(Boolean);

function collapseAmplified(text: string): string {
	let out = text;

	// Repeatedly collapse `(EXPR === true) === true) === true) ...` chains.
	let prev: string;
	do {
		prev = out;
		out = out.replace(/\(([^()]+|\([^()]*\)) === true\) === true\)/g, "($1 === true)");
		out = out.replace(/\(([^()]+|\([^()]*\)) !== true\) !== true\)/g, "($1 !== true)");
	} while (out !== prev);

	// Same for `(EXPR !== undefined && EXPR !== "")` amplifications
	do {
		prev = out;
		out = out.replace(
			/\(([^()]+|\([^()]*\)) !== undefined && \1 !== ""\) !== undefined && \1 !== ""\)/g,
			'($1 !== undefined && $1 !== "")',
		);
	} while (out !== prev);

	return out;
}

let modified = 0;
for (const f of files) {
	if (SKIP_FILES.has(f)) continue;
	let text: string;
	try {
		text = readFileSync(f, "utf8");
	} catch {
		continue;
	}

	const newText = collapseAmplified(text);
	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
