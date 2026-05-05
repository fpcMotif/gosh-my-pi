# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the canonical rulebook for AI assistants in this repo — read it in full. The notes below are a Claude-Code-specific quick reference and footgun list; everything authoritative is in AGENTS.md.

@AGENTS.md

## Quick reference

- **Default focus**: `packages/coding-agent/` (the `omp` CLI). When AGENTS.md says "agent", it means the coding-agent code, not the AI assistant.
- **Validation (use this, not `tsc`)**: `bun check:ts` — runs `oxfmt --check` + `oxlint` + `tsgo` (TypeScript native preview). Auto-fix variant: `bun fix:ts`. Ultracite is also wired in for formatting (`bunx ultracite fix` / `check` / `doctor` works).
- **Testing**: scoped per-package only, e.g. `bun --cwd=packages/coding-agent test`.
- **Generated files** — never hand-edit: `packages/ai/src/models.json`. Regenerate via `bun --cwd=packages/ai run generate-models` (or `/regen-models`).
- **Logger, not console**: `packages/coding-agent` and `packages/tui` forbid `console.*` at the lint level — use `logger` from `@oh-my-pi/pi-utils`.
- **Style**: tabs, width 3, line width 120 (`oxfmt`). Configured in `oxfmt.config.ts` which `extends: [ultracite]` then **overrides** the style settings to keep the project's tabs/width-3/line-120 (Ultracite's defaults are spaces/width-2/line-80 — would otherwise reformat the entire repo).

## Forbidden commands (AGENTS.md says NEVER)

- `tsc` / `npx tsc` — this repo uses `tsgo`, not `tsc`. Use `bun check:ts`.
- `bun test` (whole-suite, unscoped) — only run scoped per-package tests.
- `bun run dev` — not the dev workflow here.
- Hand-edit `packages/ai/src/models.json` — use `/regen-models`.

## Code-quality non-negotiables (oxlint enforces; AGENTS.md elaborates)

- No `any`. No `ReturnType<…>` — reference the actual type.
- No `private`/`protected`/`public` keywords on class members — use `#` private fields. (Constructor parameter properties are the only exception.)
- No inline / dynamic imports. Top-of-file only.
- No inline prompt strings — prompts live in `.md` files loaded via `import x from "./p.md" with { type: "text" }`, with Handlebars for dynamic content.
- `Promise.withResolvers()` over `new Promise(...)`.
- Bun APIs over Node where available: `Bun.file`, `Bun.write`, `Bun.spawn`, `$\`…\``, `Bun.JSON5`, `Bun.JSONL`, `bun:sqlite`, `Bun.stringWidth`, `Bun.wrapAnsi`, `Bun.sleep`.
- Namespace imports for `node:fs` / `node:path` / `node:os`. Never `existsSync`-then-read.
- Limits: `max-lines: 400`, `max-lines-per-function: 80`, `complexity: 12`. Some files have explicit overrides in `.oxlintrc.json` — check before refactoring to fit.

## Lint workflow (stable as of 2026-05-05)

The lint+fmt sweep landed in commits `555616195..ae2ff9698`. Working state:

- **`bun check:tools`** — `oxfmt --check` + `oxlint --quiet` on `packages/`. Should always exit 0. Adding new errors here breaks CI's `check` job.
- **`bun fix:ts`** — runs `oxfmt --write` + `oxlint --fix-dangerously` + the codemod orchestrator (lenient mode) + per-workspace fixes. Use this before committing.
- **`bun fix:ts:strict`** — same but the orchestrator aborts if any step grows the lint count. Use for sweep-style verification runs.
- **`bun scripts/lint-snapshot.ts [--diff]`** — appends a JSONL line to `.lint-history.jsonl` (gitignored) with totals, per-rule counts, and top-10 worst files. `--diff` prints deltas vs the previous entry.
- **`bun scripts/run-fix-sweep.ts [--dry-run|--no-validate|--abort-on-grow=false]`** — orchestrator. Pipeline order: `fix-or-defaulting` → `fix-null-checks` → `fix-await-loop-stop-close` → `fix-signal-aborted` → `fix-amplification`. Captures before/after counts and refuses to land any step that grows the total. Codemod scripts have been consolidated to this set; do not add new regex-based fixers without going through `scripts/lib/codemod-runner.ts`.
- **`.oxlintrc.json`** — heavy override blocks for hotspot directories (coding-agent/src, ai/src, agent/src, swarm-extension, stats, utils, natives, tui, typescript-edit-benchmark) disable the rules that the codebase can't satisfy without major refactors (`complexity`, `max-lines`, `max-lines-per-function`, `max-depth`, `no-await-in-loop`, `strict-boolean-expressions`, `no-non-null-assertion`, `no-explicit-any`, `no-misused-promises`, `unbound-method`, etc.). Each new override block needs a `// why:` comment + TODO link in the commit message because the JSON file itself can't carry them.

**Pre-commit hook**: `lint-staged` runs `oxfmt --write` + `oxlint --fix --no-error-on-unmatched-pattern` on staged `*.{js,jsx,ts,tsx}` files. The `oxlint --fix` step exits 1 on any remaining errors, so commits during the sweep used `--no-verify`. Future commits should *not* need `--no-verify` because the post-sweep error count is 0.

## Known CI failures (follow-up — out of scope of the lint sweep)

The CI `check` job is green. The other CI jobs are knowingly red and need follow-up work:

- **`check` workspace step (tsgo)** — ~849 type errors across `packages/{coding-agent,ai,stats,swarm-extension,agent,typescript-edit-benchmark,utils,tui,natives}`. To unblock CI, every workspace package's `check:types` script ends with `|| true` so tsgo errors are still printed during local check but don't fail the build. Top hotspots: `stats/src/db.ts` (~120, all `bun:sqlite` returning `unknown`), `coding-agent/src/session/agent-session.ts` (~69), `ai/src/auth-storage.ts` (~36), `ai/src/auth-resolver.ts` (~24), `ai/src/providers/openai-responses.ts` (~24). Refactor or `@ts-nocheck` per-file, then drop the trailing `|| true`.
- **`install_methods`** — dangling `./providers/{anthropic,brave,exa,gemini,jina,kagi,parallel,perplexity,searxng,synthetic,tavily}` imports + `const error = error as NodeJS.ErrnoException` shadow-var bug. The shadow-var pattern is the same one Stage 1 of the sweep reverted in `packages/coding-agent/src/tools/{gh,bash}.ts`; check `session-storage.ts` style fixes for the template.
- **`native`** — Rust build failure. Run `bun check:rs` locally to triage.
- **`test`** — depends on `native` succeeding (needs the addon).

## History footguns

- **Anthropic / Claude is NOT a supported `omp` provider.** Removed deliberately in commit `2da77ade7` (`chore: prune providers to requested core list and remove Claude/Anthropic`). Do not re-add `anthropic` provider files, descriptors, or model entries to `packages/ai/src/providers/` or `packages/ai/src/models.json` unless explicitly asked.
- **Toolchain pin: oxlint + oxfmt + tsgo.** Do not migrate to `tsc` even if tsgo install fails transiently — re-pin the version instead. `oxlint --quiet` is the only thing that gates the CI `check` job; `oxfmt --check` is the format gate. `tsgo` runs in workspace `check:types` but its errors are non-blocking until the tsgo backlog is cleared (see Known CI failures).
- **Codemod surface is consolidated.** `scripts/fix-{strict-booleans,sdk-booleans,sdk-booleans-2,or-defaulting2,add-null-check}.ts` were deleted in commit `263c1f12d`; do not resurrect. The kept ones (`fix-or-defaulting`, `fix-null-checks`, `fix-await-loop-stop-close`, `fix-signal-aborted`, `fix-amplification`, plus `fix-no-plusplus` which is committed but NOT wired into the orchestrator) all flow through the `scripts/lib/codemod-runner.ts` harness via `scripts/run-fix-sweep.ts`. New codemods should use the same harness (`runCodemod`, `captureLintTotals`, `validateChangedFiles`) so the orchestrator can refuse to land any step that grows the lint count.
- **`.oxfmtrc.json` does not exist.** The legacy JSON config was removed in commit `af6483392` because oxfmt errors out when both it and `oxfmt.config.ts` are present. `oxfmt.config.ts` is the canonical config; do not re-add `.oxfmtrc.json`.
- **`options.typeAware` is not in `.oxlintrc.json`.** Removed in commit `de3f32e48` because per-package oxlint runs (when invoked from `packages/<name>/`) reject it as "only supported in the root config" — from those subdirectories, the repo-root config IS the inherited (non-root) config from oxlint's perspective. Override-blocks already disable virtually every type-aware rule across packages/<name>/src so the practical loss is minimal. Do not re-add unless oxlint changes this behavior.

## Commands worth pinning

| Command                                         | Use                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `bun check`                                     | TS + Rust check in parallel                                                |
| `bun check:ts`                                  | oxfmt + oxlint + tsgo (workspace)                                          |
| `bun fix:ts`                                    | oxfmt --write + oxlint --fix-dangerously + per-package fixes               |
| `bun --cwd=packages/<x> test`                   | Scoped tests for one package                                               |
| `bun --cwd=packages/ai run generate-models`     | Regenerate `models.json`                                                   |
| `bun build:native`                              | Build the N-API addon (only when touching `crates/` or `packages/natives`) |
| `bun stats:run` / `stats:edits` / `stats:tools` | Session-stats analyses                                                     |
| `bun fix:ts:strict`                             | Like `bun fix:ts` but the codemod orchestrator aborts if any step grows the lint count (sweep verification) |
| `bun scripts/lint-snapshot.ts --diff`           | Show per-rule lint deltas vs the previous run (gitignored `.lint-history.jsonl`) |
| `bun scripts/run-fix-sweep.ts --dry-run`        | List the orchestrator's codemod pipeline without running it                 |

## Project skills

- `/check` — workspace TS check.
- `/fix` — auto-fix then re-check.
- `/regen-models` — regenerate `packages/ai/src/models.json`.
- `/test-pkg <package>` — scoped tests for one package.

## Hooks (in `.claude/settings.json`, committed)

- **format-on-edit**: after every `Write`/`Edit` on a `.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.json` file, runs `bunx oxfmt --write` on just that file. Silent no-op on errors so failed formats don't block edits.
- **notify-on-Stop**: macOS-only; gated to `darwin` via `[ "$(uname)" = "Darwin" ]`. Runs `say -v Samantha 'Claude is done'` in the background. Silent no-op on Linux/Windows.

## Ultracite integration (formatter only)

`oxfmt.config.ts` extends Ultracite's AI-formatter preset (`ultracite/oxfmt`) with project style overrides (tabs / width 3 / line 120 / arrow-avoid / trailing-all). The lint config (`.oxlintrc.json`) is project-curated — Ultracite's lint preset is **not** extended (would surface thousands of new errors on the active codebase). Add Ultracite lint rules incrementally if/when the active lint sweep lands.

## Commit style

Conventional commits (`type(scope): message`). No emojis in commits, issues, PRs, or branch names (per AGENTS.md).
