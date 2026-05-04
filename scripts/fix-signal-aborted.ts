#!/usr/bin/env bun
/**
 * Replace `signal?.aborted === true` with `signal !== undefined && signal.aborted`
 * to preserve TypeScript narrowing across re-checks in loops.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

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

const files = rgListFiles(`'\\.aborted === true'`);

let modified = 0;
for (const f of files) {
	if (SKIP_FILES.has(f)) continue;
	let text: string;
	try {
		text = readFileSync(f, "utf8");
	} catch {
		continue;
	}

	// Match `(EXPR?.aborted === true)` and `EXPR?.aborted === true`
	let newText = text;
	newText = newText.replace(/\(([\w.?$#]+)\?\.aborted === true\)/g, "($1 !== undefined && $1.aborted)");
	newText = newText.replace(/([\w.?$#]+)\?\.aborted === true/g, "$1 !== undefined && $1.aborted");

	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
