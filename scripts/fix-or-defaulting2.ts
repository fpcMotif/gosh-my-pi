#!/usr/bin/env bun
/**
 * Generalized fix for `(expr !== ... && expr !== ...) || X` patterns.
 * Matches arbitrary expression text (not just simple identifiers) — the
 * key is that the expression appears identically twice in the boolean check.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SKIP_FILES = new Set(["packages/coding-agent/src/export/html/template.generated.ts"]);

const files = execSync(`rg -l '\\) \\|\\|' packages --type ts -0`, { encoding: "buffer" })
	.toString("utf8")
	.split("\0")
	.filter(Boolean);

// Match `(EXPR !== <litA> && EXPR !== <litB>) ||` where EXPR is the SAME text in both halves.
// Use a backreference to enforce equality.
const exprBalanced = String.raw`((?:[^()]|\([^()]*\))+?)`; // limited paren depth, lazy

const patterns: { re: RegExp; replacement: string }[] = [
	// (E !== null && E !== undefined && E !== "") || X → E ?? X
	{
		re: new RegExp(`\\(${exprBalanced} !== null && \\1 !== undefined && \\1 !== ""\\) \\|\\| `, "g"),
		replacement: "$1 ?? ",
	},
	// (E !== null && E !== undefined && E !== 0) || X → E ?? X
	{
		re: new RegExp(`\\(${exprBalanced} !== null && \\1 !== undefined && \\1 !== 0\\) \\|\\| `, "g"),
		replacement: "$1 ?? ",
	},
	// (E !== undefined && E !== "") || X → E ?? X
	{
		re: new RegExp(`\\(${exprBalanced} !== undefined && \\1 !== ""\\) \\|\\| `, "g"),
		replacement: "$1 ?? ",
	},
	// (E !== undefined && E !== 0) || X → E ?? X
	{
		re: new RegExp(`\\(${exprBalanced} !== undefined && \\1 !== 0\\) \\|\\| `, "g"),
		replacement: "$1 ?? ",
	},
	// (E === true) || X → E ?? X (was E || X for nullable boolean, less safe)
	{
		re: new RegExp(`\\(${exprBalanced} === true\\) \\|\\| `, "g"),
		replacement: "$1 ?? ",
	},
	// (E !== null && E !== undefined) || X → E ?? X
	{
		re: new RegExp(`\\(${exprBalanced} !== null && \\1 !== undefined\\) \\|\\| `, "g"),
		replacement: "$1 ?? ",
	},
];

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
	for (const { re, replacement } of patterns) {
		newText = newText.replace(re, replacement);
	}

	if (newText !== text) {
		writeFileSync(f, newText);
		modified++;
	}
}

console.log(`Modified ${modified} files`);
