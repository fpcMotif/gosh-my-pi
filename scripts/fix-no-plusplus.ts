#!/usr/bin/env bun

/**
 * Auto-fix `eslint(no-plusplus)`.
 *
 * Rewrites statement-level (and for-loop update) `x++` / `x--` / `++x` / `--x`
 * into `x += 1` / `x -= 1` using ast-grep so we never touch occurrences inside
 * expressions (e.g. `arr[i++]`, `foo(i++)`) where the semantics differ.
 *
 * Run:  bun scripts/fix-no-plusplus.ts
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const here = import.meta.dirname;
const ruleFile = resolve(here, "lint-rules/no-plusplus.yml");
const targets = process.argv.slice(2);
const paths = targets.length > 0 ? targets : ["packages"];

const result = spawnSync("ast-grep", ["scan", "--rule", ruleFile, "-U", ...paths], {
	stdio: "inherit",
});

process.exit(result.status ?? 1);
