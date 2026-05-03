---
name: check
description: Run workspace TypeScript check (oxfmt + oxlint + tsgo) via `bun check:ts`. Use after edits to verify formatting, lint, and types in one shot. Trigger on "check", "/check", "verify", "type check", "validate TS".
---

Run `bun check:ts` from the repo root.

This executes:

- `oxfmt --check` (formatting; non-mutating)
- `oxlint` (lint)
- `tsgo` (`@typescript/native-preview` — NOT `tsc`)

If failures appear:

- **Formatting** — suggest `/fix` (which runs `bun fix:ts`).
- **Lint** — read the rule violation, locate the line, propose a minimal change. Some files have explicit overrides in `.oxlintrc.json` — check overrides before forcing a refactor to satisfy a rule that the file is allowed to violate.
- **Types** — read the diagnostic, fix at the root cause. NEVER add `any` or `// @ts-expect-error` to silence — both are forbidden by AGENTS.md.

Do NOT run `tsc` / `npx tsc` — this repo uses `tsgo`, and `bun check:ts` invokes it.

Do NOT run `bun test` after — full-suite is forbidden (see AGENTS.md). Use `/test-pkg` if tests are needed.
