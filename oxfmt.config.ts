import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// Extends Ultracite's AI-formatter preset, then overrides style settings to
// preserve this repo's existing formatting (tabs, width 3, line 120). Without
// these overrides, applying Ultracite's defaults would reformat the entire
// codebase to spaces / width 2 / line 80.
//
// AGENTS.md is the source of truth for style policy.
export default defineConfig({
	extends: [ultracite],

	// ── Project style (overrides Ultracite defaults) ───────────────────
	useTabs: true,
	tabWidth: 3,
	printWidth: 120,
	arrowParens: "avoid",
	trailingComma: "all",
	insertFinalNewline: true,

	// ── Ignored paths (matches the previous .oxfmtrc.json plus generated files) ──
	ignorePatterns: [
		"packages/natives/native/index.d.ts",
		"**/vendor/**/*",
		"**/node_modules/**/*",
		"**/test-sessions.ts",
		"**/template.generated.ts",
		"**/docs-index.generated.ts",
		"**/gen/agent_pb.ts",
		".worktrees/**/*",
		".wt/**/*",
		// Generated — NEVER hand-edit (per AGENTS.md). Regenerate via `bun --cwd=packages/ai run generate-models`.
		"packages/ai/src/models.json",
	],
});
