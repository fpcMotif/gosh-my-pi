#!/usr/bin/env bun
/**
 * Replace `(x != null)` with `(x !== null && x !== undefined)`
 * and `(x == null)` with `(x === null || x === undefined)`
 * to satisfy the eqeqeq rule.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

const files = execSync(
	`rg -l ' != null| == null' packages --type ts -0`,
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

	// Match (expr != null) where expr is identifier optionally followed by .prop, ?.prop, [idx], (...) chains
	const re = /\(([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[\w$]+|\[[^[\]]+\]|\?\.)*) (!=|==) null\)/g;
	const newText = text.replace(re, (_match, expr: string, op: string) => {
		if (op === "!=") return `(${expr} !== null && ${expr} !== undefined)`;
		return `(${expr} === null || ${expr} === undefined)`;
	});
	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
