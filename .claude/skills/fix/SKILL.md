---
name: fix
description: Auto-fix formatting and lint via `bun fix:ts`, then re-check. Use after a refactor or when /check reports auto-fixable issues. Trigger on "fix", "/fix", "format code", "auto-fix lint".
---

1. Run `bun fix:ts` from the repo root. This executes `oxfmt --write` + `oxlint --fix-dangerously` + per-package fix scripts.
2. Run `bun check:ts` to confirm the remaining state.
3. Summarize: file count changed, kinds of fixes applied, what still needs manual attention.

**Risk callout**: `--fix-dangerously` can change semantics — removed null checks, altered boolean coercions, etc. The repo currently has an active lint-fix sweep (see `scripts/fix-*.ts` codemods + root `lint-errors.txt`), so some auto-fixes have already been validated and others have not. After running, scan the diff for anything that looks like a behavior change and call it out — don't assume green is correct.
