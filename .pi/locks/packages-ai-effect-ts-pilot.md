# Active Refactor — packages/ai effect-ts pilot

**Status:** Phase 1 done; Phase 2 deferred (concurrent edit collision)
**Owner:** thread T-019df0d5-8170-715a-981d-5c674c4fe9fc → T-019df0e8-a985-735c-983e-786a12e9e6e8 → next handoff
**Started:** 2026-05-04
**Scope:** `packages/ai/**`, plus mechanical sweep of `packages/utils/`, `packages/agent/`, `packages/natives/`.

## Phase 1 results (T-019df0e8)

- `packages/utils`: 0 lint errors, 0 type errors, 42 warnings.
   - Fix: completed concurrent agent's `timeoutId` → `timer.ref` rename in `src/async.ts` (two missed call sites caused TS2304).
   - Fix: `unicorn/catch-error-name` rename `err` → `error` in `src/logger.ts` (line 197).
- `packages/natives`: 0 lint errors, 0 type errors, 37 warnings.
   - Fix: added `**/native/index.{js,d.ts}`, `**/native/loader-state.js`, `**/export/html/template.js` globs to `.oxlintrc.json` `ignorePatterns` so per-package oxlint (cwd=packages/natives) honors the same ignores as the workspace-rooted invocation.
   - Fix: extended `packages/natives/tsconfig.json` `include` to list `../../scripts/host-detect.ts` and `../../scripts/ci-release-verify-natives.ts` (already imported by build/test files; tsgo TS6307 fix).
- `packages/agent`: 0 own lint errors, 152 warnings. Transitive TS errors only — they bottom out in `packages/ai`'s broken module graph (see Phase 2 notes).

## Phase 2 status: deferred

Baseline assumed 212 lint errors in `packages/ai`. Reality on entry to this thread:

- `packages/ai` lint: **0 errors / 716 warnings** (the "212" was a different metric).
- `packages/ai` types: **~30 type errors** caused by an in-progress provider-pruning refactor by a concurrent committer/agent: references to non-existent modules (`./providers/anthropic`, `./providers/shared/error-message`, `./utils/schema/utils`, `./utils/oauth/token-profile`) and missing exports (`refreshMinimaxCodeToken`, `refreshMoonshotToken`, `refreshZaiToken`, `ANTHROPIC_THINKING`, `DEFAULT_CACHE_TTL_MS`, `OpenAICompatibleModelRecord`).
- 82 files in `packages/ai/` are uncommitted-modified by the concurrent agent.

Per AGENTS.md ("do NOT revert, undo, or modify changes you did not make unless I explicitly ask. If files vanish or change under you, just continue with the new state") and the lock contract, this thread did NOT:

1. Revert any of the concurrent agent's pruning work.
2. Restore the deleted `./providers/anthropic` etc. modules.
3. Layer Effect-ts on top of a broken module graph (would amplify the breakage).

## Recommended next steps for the successor thread

1. **First**: confirm the concurrent agent has finished and committed the provider-pruning refactor. Either wait for their commit or coordinate via `.pi/locks/comm.md`.
2. Once `bun --cwd=packages/ai run check:types` is clean, _then_ start the Effect-ts pilot:
   - Add `effect` (catalog: `3.21.2`) and `@effect/language-service` (catalog: `0.85.1`) to `packages/ai/package.json` `dependencies` / `devDependencies`.
   - Boundary contract to preserve: `StreamFunction<TApi>` and `AssistantMessageEventStream` in `packages/ai/src/types.ts` and `packages/ai/src/utils/event-stream`.
   - Highest-leverage internal refactor target: the ~23 `no-await-in-loop` sites → `Effect.forEach({ concurrency })`.
   - Wrap every public export with `Effect.runPromise` / `Stream.toAsyncIterable` adapter so the 105 consumer files in `packages/coding-agent` see no API change.
3. **Reality check on the original lint-warning campaign**: most of the 716 warnings are `no-explicit-any` (36), `strict-boolean-expressions` (59), `complexity` (44), `max-lines-per-function` (9) — these are TypeScript hygiene + structural refactors, not concurrency primitives. Effect-ts will not directly drive these counts down. Track the two work streams (Effect-ts integration vs. warning cleanup) separately.

## Infra notes carried over (do not re-discover)

- `.oxfmtrc.json` is the active formatter (ignore the deleted `oxfmt.config.ts`).
- `.oxlintrc.json` has `options.typeAware: true`; per-package scripts pass `--config ../../.oxlintrc.json` because oxlint rejects `typeAware` if config is not at the root from cwd's perspective.
- `bun check:ts` = workspace-wide measure (root oxfmt + oxlint + per-workspace check).
- `bun --cwd=packages/<pkg> test` after each chunk; e2e (`*.e2e.test.ts`) only at session end.
- Already-fixed real bugs (do not touch): `packages/coding-agent/src/ipy/executor.ts`, `packages/coding-agent/src/session/session-storage.ts`, `packages/coding-agent/src/ipy/gateway-coordinator.ts`.

## What this lock means

Other agents: please do not edit files under `packages/ai/src/**` or the listed
trivial packages while this lock exists. The active thread is performing a
multi-step effect-ts pilot refactor; concurrent edits will collide and force
re-application of work.

If you need to land an unrelated, time-sensitive change here, leave a note in
`.pi/locks/comm.md` and the active thread will rebase or yield.

## Plan (locked-in via /grill-me Q1–Q7)

- **Q1 (C):** Per-package campaign, not workspace-wide.
- **Q2:** Trivial sweep first (utils 7 / agent 4 / natives 2 = 13 errors),
  then pilot `packages/ai` (212 errors).
- **Q3 (B):** Refactor by default. `// oxlint-disable-next-line <rule> -- <reason>`
  is allowed only with a one-line justification when splitting genuinely harms
  clarity (e.g. parser state machines, exhaustive tag dispatchers).
- **Q4 (A) + Q5 (C):** Full effect-ts integration _internally_ in `packages/ai`,
  with Promise/EventStream **adapters at every public export** so the 105
  consumer files in `packages/coding-agent` see no API change. Migrate consumers
  to native Effect APIs in a later coding-agent campaign — no flag day.
- **Q6 (C):** Tests must always pass. Lint error count trends monotonically
  down per file refactored. e2e (`*.e2e.test.ts`) run once at session end.
  Authorized: `bun --cwd=packages/ai test`.
- **Q7 (C):** Handoff to a fresh thread for execution.

## Released by

Delete this file when the pilot is complete and merged.
