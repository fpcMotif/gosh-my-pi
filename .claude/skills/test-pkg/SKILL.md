---
name: test-pkg
description: Run tests for ONE package via `bun --cwd=packages/<name> test`. ALWAYS use this instead of bare `bun test` (which runs the forbidden whole-suite). Pass the package name as argument, e.g. `/test-pkg coding-agent`. Trigger on "/test-pkg", "test the X package", "run tests for X".
---

Argument: `$ARGUMENTS` — a single package directory name from `packages/`. Valid options: `coding-agent`, `ai`, `tui`, `agent`, `utils`, `natives`, `stats`, `swarm-extension`, `typescript-edit-benchmark`.

Steps:

1. Resolve target: `packages/$ARGUMENTS`. If it doesn't exist, list `packages/*` and ask the user which they meant.
2. Run `bun --cwd=packages/$ARGUMENTS test`.
3. If the user follows up with a specific test name, re-run with `bun --cwd=packages/$ARGUMENTS test --test-name-pattern <name>`, or invoke `bun test <file>` from inside that package.

**Never run** bare `bun test` from the repo root, `bun run --workspaces test`, or any command that triggers the full suite — AGENTS.md forbids it.

If the user just wants the failing tests from the previous run, prefer `bun run test:ts` (which uses `--only-failures`) over re-running everything.
