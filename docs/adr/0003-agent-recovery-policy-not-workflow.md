# ADR 0003: Agent recovery is a policy over the existing JSONL, not a durable workflow

## Status

Accepted — 2026-05-07. Scopes Effect-TS-v4-migration phase P3
("durable workflow #1: agent turn pump") in the migration plan.

## Context

The Effect TS v4 migration plan originally proposed extracting an
"agent turn pump" into `packages/agent/src/workflows/turn-pump.ts`,
backed by a new `DurableLog` Layer wrapping `NdjsonFileWriter`, and
persisting per-step checkpoints of the shape
`{turnId, phase, toolCallId?, requestPayload, responseChunkSeq,
completed}`. The implied semantics were Effect-`Workflow`-style
durable execution — survive a `kill -9` mid-turn, resume mid-stream
or mid-tool from the last checkpoint.

Three load-bearing facts in the current code make that framing wrong:

1. **The session JSONL written by `NdjsonFileWriter` already is the
   durable log.** Every `AgentEvent` flows through it. A parallel
   `turn-checkpoint` line type duplicates the existing event taxonomy
   (`message_start | message_update | message_end |
tool_execution_start | tool_execution_end | turn_end | agent_end`)
   with worse structure (`phase` is undefined; `requestPayload` is
   already on disk via `appendMessage`).

2. **Agent tools are not idempotent.** `bash`, `edit`, MCP calls all
   have side effects. Auto-resuming a `tool_execution_start` after a
   crash would double-apply. Per-step "resume from `lastChunkSeq +
1`" semantics are only meaningful for streaming LLM calls (P4),
   not for agent turns (P3). Conflating the two bakes a footgun into
   the workflow primitive.

3. **`RetryController` already owns the in-process retry boundary.**
   It calls `agent.replaceMessages(messages.slice(0, -1))`, sleeps
   with `abortableSleep`, and `scheduleAgentContinue`. The `mid-stream`
   recovery shape we need on next-process-boot is the same shape it
   uses on `transient` errors today. A new "DurableLog" subsystem
   that ignores `RetryController` either competes with it or duplicates
   it.

## Decision

P3 introduces a **RecoveryPolicy**, not a durable workflow.

- A new typed JSONL line `event: "recovery-marker"` is appended at
  three well-defined safe points (after `message_end`, after each
  `tool_execution_end`, after `turn_end`). It carries
  `{generation, lastEventSeq, isStreaming, pendingToolCallIds}` and
  is the only new persistence shape introduced by P3.
- A new `RecoveryPolicy` module runs once on session reopen, reads
  the session JSONL tail and the latest `RecoveryMarker`, and
  classifies the crash state into:
   - `safe` — do nothing, session resumes idle.
   - `mid-stream` — discard the partial assistant message and re-call
     `agent.continue()` from `messages.slice(0, -1)`. Same shape
     `RetryController` already uses on transient errors.
   - `mid-tool` — append a synthetic `tool_execution_end` with
     `isError: true, errorMessage: "interrupted by crash"`, then
     `continue()`. **Never re-run the tool.**
- The Effect surface introduced by P3 is `AgentRunController` in
  `packages/agent/src/run/agent-run.ts` — a thin
  `Effect<void, AgentRunError, RecoveryMarker | Clock | Logger>`
  shell over `Agent.prompt` / `Agent.continue`. Public callers see
  `Promise<void>`. `RetryController` keeps owning the in-process retry
  loop; `AgentRunController` does not replace it.
- `NdjsonFileWriter` is **not** wrapped by a new Layer. The
  `RecoveryMarker` Layer is ~40 lines and appends one line type via
  the existing writer.

## Considered options

- **Effect v4 `Workflow` durable execution.** Rejected: v4 is
  pre-release as of 2026-05-07 (per migration-plan Risk §1) and
  `Workflow` is the v4-only surface the plan explicitly forbids
  until v4 GA. Adopting it now would block the migration on upstream.
- **`DurableLog` Layer wrapping `NdjsonFileWriter` with per-step
  checkpoints.** Rejected: duplicates the existing event log, inflates
  storage by `O(turn_steps × messages.length)`, and pretends turns
  are resumable when their tool side effects make them not.
- **Fold recovery directly into `RetryController`.** Rejected:
  `RetryController` is in-process and event-driven; recovery runs
  once at session-reopen time, before any event listeners are wired.
  Different lifecycle, different owner.

## Consequences

- The `mid-tool = synthetic error tool_result, no re-run` rule is
  load-bearing for safety. Any future "auto-resume bash" feature must
  be a separate, opt-in mechanism per tool, not an extension of
  `RecoveryPolicy`.
- P3's deliverable shrinks from "new workflow subsystem" to "one new
  JSONL line + one new module + one thin Effect wrapper". P4
  (streaming LLM resume) inherits the same `RecoveryMarker`
  infrastructure for chunk-seq checkpoints, but its semantics —
  `mid-stream` discard-and-restart — are already covered by the
  `mid-stream` policy bucket.
- A future migration to Effect v4 `Workflow` is not blocked by this
  ADR; it would be a separate decision that replaces both
  `AgentRunController` and `RecoveryPolicy` after v4 GA.
