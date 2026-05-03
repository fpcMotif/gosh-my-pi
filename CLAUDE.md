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

## Active migrations (transient — verify before relying)

- **Lint-fix sweep in progress**: codemods live in `scripts/fix-*.ts` (e.g., `fix-strict-booleans.ts`, `fix-await-loop.ts`, `fix-null-checks.ts`). The 9 MB `lint-errors.txt` (root + per-package) is the input file. Working tree is dirty across `packages/ai` and `packages/coding-agent` while this lands. After auto-fixes, scan diffs for semantic regressions (removed null checks, changed boolean coercions).

## History footguns

- **Anthropic / Claude is NOT a supported `omp` provider.** Removed deliberately in commit `2da77ade7` (`chore: prune providers to requested core list and remove Claude/Anthropic`). Do not re-add `anthropic` provider files, descriptors, or model entries to `packages/ai/src/providers/` or `packages/ai/src/models.json` unless explicitly asked.

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
