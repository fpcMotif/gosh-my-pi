#!/usr/bin/env bun

/**
 * Run every safe, mechanical lint auto-fixer in sequence.
 *
 * Each step fixes a single oxlint rule using the most precise tool:
 *   - ast-grep (statement-aware rewrites)
 *   - hand-written tokenisers (lexical/trivia preservation)
 *   - shell scripts (path-based bulk operations)
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const here = import.meta.dirname;

interface Step {
	name: string;
	rule: string;
	command: [string, string[]];
}

const steps: Step[] = [
	{
		command: ["bun", [resolve(here, "fix-no-plusplus.ts")]],
		name: "no-plusplus",
		rule: "eslint(no-plusplus)",
	},
	{
		command: ["ast-grep", ["scan", "--rule", resolve(here, "lint-rules/no-negated-condition.yml"), "-U", "packages"]],
		name: "no-negated-condition",
		rule: "eslint(no-negated-condition)",
	},
	{
		command: ["ast-grep", ["scan", "--rule", resolve(here, "lint-rules/no-lonely-if.yml"), "-U", "packages"]],
		name: "no-lonely-if",
		rule: "eslint(no-lonely-if)",
	},
	{
		command: ["ast-grep", ["scan", "--rule", resolve(here, "lint-rules/strict-booleans.yml"), "-U", "packages"]],
		name: "strict-booleans",
		rule: "typescript-eslint(strict-boolean-expressions)",
	},
	{
		command: ["ast-grep", ["scan", "--rule", resolve(here, "lint-rules/test-fixes.yml"), "-U", "packages"]],
		name: "test-fixes",
		rule: "typescript-eslint(no-non-null-assertion)",
	},
	{
		command: ["ast-grep", ["scan", "--rule", resolve(here, "lint-rules/escape-case.yml"), "-U", "packages"]],
		name: "escape-case",
		rule: "unicorn/escape-case",
	},
];

let failed = false;

for (const step of steps) {
	console.log(`\n\u001B[1m\u001B[36m▸ ${step.name}\u001B[0m  \u001B[2m(${step.rule})\u001B[0m`);
	const res = spawnSync(step.command[0], step.command[1], { stdio: "inherit" });
	if (res.status !== 0) {
		failed = true;
		console.error(`  \u001B[31m✗ ${step.name} exited with code ${res.status}\u001B[0m`);
	}
}

console.log("\nDone. Re-run `bun check` to see remaining lint errors.");
process.exit(failed ? 1 : 0);
