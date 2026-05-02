#!/usr/bin/env bun
/**
 * Fix wrongly-applied transformations of `x || N` defaulting patterns.
 * The script earlier wrapped `x` in a boolean check for strict-boolean-expressions,
 * but `x` was actually in `||` defaulting position (RHS of assignment, function arg, etc.)
 * The fix is to use `?? N` instead.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

const files = execSync(`rg -l '\\(.+\\) \\|\\|' packages --type ts -0`, { encoding: "buffer" })
	.toString("utf8")
	.split("\0")
	.filter(Boolean);

let modified = 0;
for (const f of files) {
	if (SKIP_FILES.has(f)) continue;
	let text: string;
	try {
		text = readFileSync(f, "utf8");
	} catch {
		continue;
	}

	let newText = text;

	// Long form: (x !== null && x !== undefined && x !== "") || N → x ?? N
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== null && \1 !== undefined && \1 !== ""\) \|\| /g,
		"$1 ?? ",
	);
	// Long form: (x !== null && x !== undefined && x !== 0) || N → x ?? N
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== null && \1 !== undefined && \1 !== 0\) \|\| /g,
		"$1 ?? ",
	);
	// Short form (legacy): (x !== undefined && x !== "") || N → x ?? N
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== undefined && \1 !== ""\) \|\| /g,
		"$1 ?? ",
	);
	// Short form: (x !== undefined && x !== 0) || N → x ?? N
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== undefined && \1 !== 0\) \|\| /g,
		"$1 ?? ",
	);
	// (x === true) || N → x ?? N (was x || N for nullable boolean)
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) === true\) \|\| /g,
		"$1 ?? ",
	);
	// (x !== null && x !== undefined) || N — any-typed default
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== null && \1 !== undefined\) \|\| /g,
		"$1 ?? ",
	);

	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
