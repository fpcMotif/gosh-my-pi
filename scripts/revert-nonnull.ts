#!/usr/bin/env bun
/**
 * Revert `!.` → `?.` and `![` → `?.[` transformations introduced by lint-fix.ts.
 * The `no-non-null-assertion` rule is `warn` (not `error`), and removing the
 * non-null assertion frequently breaks TypeScript narrowing. Better to leave
 * them as warnings.
 *
 * We diff against HEAD: any line where HEAD had `!.` or `![` and we now have
 * `?.` or `?.[` at the same logical position is reverted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

const modifiedFiles = execSync("git diff --name-only --diff-filter=M packages", { encoding: "utf8" })
	.split("\n")
	.filter(f => f.endsWith(".ts") || f.endsWith(".tsx"));

let modified = 0;
for (const f of modifiedFiles) {
	if (SKIP_FILES.has(f)) continue;
	let head: string;
	let current: string;
	try {
		head = execSync(`git show HEAD:${f}`, { encoding: "utf8" });
		current = readFileSync(f, "utf8");
	} catch {
		continue;
	}

	const headLines = head.split("\n");
	const curLines = current.split("\n");
	if (headLines.length !== curLines.length) {
		// Line counts differ — too risky to revert by line. Skip.
		continue;
	}

	let changed = false;
	for (let i = 0; i < curLines.length; i++) {
		const headLine = headLines[i];
		const curLine = curLines[i];
		if (headLine === curLine) continue;

		// Same length might still differ. Check if HEAD had `!.` or `![` where current has `?.` or `?.[`.
		if (headLine.includes("!.") || headLine.includes("![")) {
			// Try to reverse-apply: replace `?.` with `!.` and `?.[` with `![` only at positions
			// where HEAD had the original. Since we can't track positions across edits, we do a
			// conservative full-line replacement: if removing all `!`s from HEAD matches current
			// line shape, the transformation is recoverable.

			// Simpler heuristic: take the HEAD line as the source of truth IF the only difference
			// is `!.` vs `?.` and `![` vs `?.[`.
			const normalizedHead = headLine.replace(/!\./g, "?.").replace(/!\[/g, "?.[");
			if (normalizedHead === curLine) {
				curLines[i] = headLine;
				changed = true;
			}
		}
	}

	if (changed) {
		writeFileSync(f, curLines.join("\n"));
		modified++;
	}
}

console.log(`Modified ${modified} files`);
