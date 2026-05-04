#!/usr/bin/env bun
/**
 * Collapse defensive `(x !== null && x !== undefined) || N` patterns to `x ?? N`.
 *
 * IMPORTANT: only the (null && undefined) → ?? collapse is semantically equivalent.
 * The earlier version of this script also collapsed `(x !== "" || x !== 0)` and
 * `(x === true)` patterns, which silently flipped behavior:
 *   - `(x !== "" ...) || N` returns N when x is `""`; `x ?? N` returns `""`.
 *   - `(x !== 0 ...) || N` returns N when x is `0`; `x ?? N` returns `0`.
 *   - `(x === true) || N` returns N when x is `false`; `x ?? N` returns `false`.
 * Those rules have been removed. Do not re-add without per-call-site review —
 * see `packages/coding-agent/src/tools/{gh,bash}.ts` for the bugs they caused.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

function rgListFiles(pattern: string): string[] {
	try {
		return execSync(`rg -l ${pattern} packages --type ts -0`, { encoding: "buffer" })
			.toString("utf8")
			.split("\0")
			.filter(Boolean);
	} catch {
		// rg exits 1 when no matches — treat as empty result.
		return [];
	}
}

const files = rgListFiles(`'\\(.+\\) \\|\\|'`);

let modified = 0;
for (const f of files) {
	if (SKIP_FILES.has(f)) continue;
	let text: string;
	try {
		text = readFileSync(f, "utf8");
	} catch {
		continue;
	}

	// Only safe rule: (x !== null && x !== undefined) || N → x ?? N
	const newText = text.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== null && \1 !== undefined\) \|\| /g,
		"$1 ?? ",
	);

	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
