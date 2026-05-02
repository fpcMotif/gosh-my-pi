#!/usr/bin/env bun
/**
 * Upgrade earlier transformations:
 *   `(x !== undefined && x !== "")` → `(x !== null && x !== undefined && x !== "")`
 *   `(x !== undefined && x !== 0)` → `(x !== null && x !== undefined && x !== 0)`
 *   `(x === undefined || x === "")` → `(x === null || x === undefined || x === "")`
 *   `(x === undefined || x === 0)` → `(x === null || x === undefined || x === 0)`
 *
 * This preserves TypeScript narrowing for `string | null | undefined` types and
 * avoids breaking compilation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

const files = execSync(
	`rg -l '!== undefined && [A-Za-z_$#][\\w$.?#]* !== (""|0)|=== undefined \\|\\| [A-Za-z_$#][\\w$.?#]* === (""|0)' packages --type ts -0`,
	{ encoding: "buffer" },
)
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

	// (x !== undefined && x !== "") → (x !== null && x !== undefined && x !== "")
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== undefined && \1 !== ""\)/g,
		'($1 !== null && $1 !== undefined && $1 !== "")',
	);
	// (x !== undefined && x !== 0) → (x !== null && x !== undefined && x !== 0)
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) !== undefined && \1 !== 0\)/g,
		"($1 !== null && $1 !== undefined && $1 !== 0)",
	);
	// (x === undefined || x === "") → (x === null || x === undefined || x === "")
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) === undefined \|\| \1 === ""\)/g,
		'($1 === null || $1 === undefined || $1 === "")',
	);
	// (x === undefined || x === 0) → (x === null || x === undefined || x === 0)
	newText = newText.replace(
		/\(([A-Za-z_$#][\w$]*(?:(?:\?\.|\.)[#\w$]+|\[[^[\]]+\])*) === undefined \|\| \1 === 0\)/g,
		"($1 === null || $1 === undefined || $1 === 0)",
	);

	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
