# ADR 0008: Cancellation typing is package-local; TurnAborted is never raised from pi-ai

## Status

Accepted — 2026-07-11. Records the rejection of a 2026-07 architecture-review
candidate so future reviews do not re-propose it.

## Context

Cancellation intent crosses module seams as sentinel strings compared by
exact equality: `"Compaction cancelled"` / `"Handoff cancelled"` thrown at
`packages/coding-agent/src/session/agent-session.ts:3248,3303,3478,3497`
and string-matched at
`packages/coding-agent/src/modes/controllers/command-controller.ts:896,944`;
`"Request was aborted"` thrown in `packages/agent/src/agent.ts:548` and
three pi-ai provider files, compared in
`modes/components/assistant-message.ts`.

The review proposed replacing all of them with the declared-but-unraised
`TurnAborted` tag from `packages/agent/src/errors.ts`. An adversarial
necessity check refuted the proposal:

1. **Dependency direction.** Five of the eight throw sites live in pi-ai.
   pi-agent-core depends on pi-ai, not the reverse (stated in
   `packages/agent/src/errors.ts` and ADR-0004), so pi-ai cannot import
   `TurnAborted` without an import cycle. The refactor as specified is
   structurally impossible for the majority of its sites.
2. **ADR-0004 reserves the tag.** `TurnAborted` is the planned typed
   bridge for Effect-interrupt aborts at the `AgentRunController` seam —
   a different mechanism from these synchronous throws. Wiring it here
   would collide with that rollout.
3. **No observed churn.** `git log -S` shows the sentinel strings have
   effectively never changed (one move-only commit for
   "Compaction cancelled"; introduction-only for "Handoff cancelled"),
   so the drift risk the refactor guards against has not materialized.
4. **Prior art.** An unmerged exploration branch
   (`origin/claude/finalize-p4-series`, commit `2bea2e894a`) attempted
   the TurnAborted wiring, touched only pi-agent-core, left the pi-ai
   sites alone, and was shelved.

## Decision

- `TurnAborted` remains reserved for the ADR-0004 Effect-interrupt
  bridge at the agent-run seam. It is never constructed in pi-ai.
- The accepted minimal alternative: package-local typed cancellation
  errors in coding-agent — `CompactionCancelledError` /
  `HandoffCancelledError` (plain `Error` subclasses checked via
  `instanceof`, following the `ToolAbortError` precedent in
  `packages/coding-agent/src/tools/tool-errors.ts`). This removes the
  exact-string `===` checks without crossing any package seam.
- The pi-ai provider `"Request was aborted"` throws stay as-is:
  intra-function control flow with one low-stakes UI consumer, gated
  behind `stopReason === "aborted"` first.

## Consequences

- Future architecture reviews should not re-propose TurnAborted for
  sentinel replacement; the blocking facts are structural, not
  preferential.
- If the ADR-0004 bridge lands and pi-ai gains a tagged local abort
  taxonomy of its own (per `LocalAbort` precedent), revisiting the
  provider sentinel strings becomes a separate, then-feasible decision.
