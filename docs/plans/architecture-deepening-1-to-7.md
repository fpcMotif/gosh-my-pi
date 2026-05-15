# Architecture Deepening Plan: Candidates 1 to 7

Status: draft plan for sequential execution.

This plan follows the vocabulary in `CONTEXT.md` and `improve-codebase-architecture/LANGUAGE.md`:
**Module**, **Interface**, **Implementation**, **Depth**, **Seam**, **Adapter**, **Leverage**, **Locality**.

## Ground rules

1. Execute candidates in order, one candidate per reviewable change set.
2. Before each candidate, do a short grilling checkpoint: confirm the Module name, the Interface shape, and the invariants that must not move.
3. Update `CONTEXT.md` when a Module name becomes load-bearing.
4. If a candidate contradicts an accepted ADR, either stop or write a follow-up ADR before implementing.
5. Keep behavior unchanged unless the plan explicitly says otherwise.
6. Each candidate must add or preserve tests at the Module Interface, not only against internals.
7. Prefer deleting shallow pass-through Modules after the replacement has tests.

## Execution order overview

| Step | Candidate                          | Primary package                            | Expected shape                                                    |
| ---- | ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| 1    | AgentSession Reactor event routing | `packages/coding-agent`                    | Ordered event-router Module                                       |
| 2    | PostPromptRecovery scheduler       | `packages/coding-agent`                    | Deep continuation scheduler Module                                |
| 3    | RecoveryLedger write-side          | `packages/coding-agent` / `packages/agent` | Recovery marker state Module                                      |
| 4    | ContextPressure decision Module    | `packages/coding-agent`                    | Pure compaction/promotion decision Module                         |
| 5    | ToolPresentation Module            | `packages/coding-agent`                    | Neutral tool presentation data + rendering Adapters               |
| 6    | Direct RpcModelCatalog picker      | `apps/tui-go` + RPC types                  | Picker consumes backend catalog directly                          |
| 7    | Collapse gmp-only Workspace seam   | `apps/tui-go`                              | Remove hypothetical `IsGmpMode` Seam and narrow caller Interfaces |

---

## Execution state

- [x] **Step 1 complete** — `AgentEventRouter` extracted and wired as ordered display-event router for `#handleAgentEvent` with event-start queue cleanup and assistant display deobfuscation.
   - _Downside/rollback:_ Router is a narrow shim (display-layer only) so remaining ordering logic stays in `AgentSession`; if this split causes regressions, rollback by restoring those three responsibilities directly in `#handleAgentEvent`.
- [x] **Step 2 complete** — PostPromptRecovery scheduler refactor.
   - _Downside/rollback:_ `PostPromptScheduler` centralizes all delayed continuation logic; if regressions appear around scheduling edges (cancel vs skip semantics, prompt-generation mismatch, or continuation nesting with retry/TTSR), rollback by restoring local `#schedulePostPromptTask` plus direct `#postPromptTasks*`/`#waitForPostPromptRecovery` handling in `AgentSession` for one change set before reworking with narrower helpers.
- [x] **Step 3 complete** — RecoveryLedger write-side extraction.
   - _Downside/rollback:_ RecoveryLedger centralizes recovery-marker write timing and state; if it causes sequencing confusion, rollback by moving write timing back into AgentSession while keeping RecoveryMarker writes in one place and reintroducing a thinner helper on a smaller scope.
- [x] **Step 4 complete** - ContextPressure decision module.
   - _Downside/rollback:_ `ContextPressurePolicy` improves decision-table testability but adds one more hop between the automatic compaction trigger and the session mutations. If debugging pressure decisions gets harder, rollback by moving `decideContextPressure` back into `#checkCompaction` while keeping the pure candidate-ordering tests as a guard.
- [ ] **Step 5 pending** - ToolPresentation module.
   - _Progress:_ First slice added neutral `ToolPresentation` status/block data, a legacy `pi-tui` Adapter, `ToolExecutionComponent` preference for presentation data, and `bash`/non-URL `read` call-summary migration. Second slice added non-vim `edit`/`apply_patch` call-summary presentation data while leaving legacy result rendering intact.
   - _Downside/rollback:_ Result rendering and edit diff result presentation are still legacy-renderer owned because their width-sensitive output needs a separate migration. Rollback by removing `presentCall`/`presentResult` preference in `ToolExecutionComponent` and leaving the adapter module unused.
- [ ] **Step 6 pending** — Direct `RpcModelCatalog` picker.
- [ ] **Step 7 pending** — Collapse gmp-only `Workspace` seam.

## 1. AgentSession Reactor event routing

### Files

- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/ttsr-engine.ts`
- `packages/coding-agent/src/session/retry-controller.ts`
- `packages/coding-agent/src/session/streaming-edit-guard.ts`
- `packages/coding-agent/src/session/todo-phase-state.ts`
- Tests under `packages/coding-agent/test/` for session event behavior

### Problem

`AgentSession.#handleAgentEvent` still holds too much ordered behavior in one Implementation:

- Recovery marker counters and pending tool ids.
- Pending visible-message removal.
- display-event deobfuscation.
- external event emission.
- TTSR stream interruption and retry scheduling.
- streaming edit guard cache updates.
- session persistence.
- tool-result side effects.
- post-turn retry, compaction, rewind, todo completion.

The **Reactor** term already exists in `CONTEXT.md`, but the current Implementation is still a large method rather than a deep Module. The current Interface is effectively “edit this method carefully and know all ordering constraints.�?That is shallow.

### Deletion test

If `#handleAgentEvent` were deleted today, its complexity would reappear across every session subsystem. That means the behavior is real and deserves a deeper Module. But the current method does not give callers or tests enough Leverage.

### Target shape

Create an ordered event-routing Module owned by `AgentSession`.

Working name: `AgentEventRouter` or `SessionEventRouter`.

The Module should hide ordered event handling behind a small Interface, for example:

- `handle(event)`
- `dispose()` if needed later

The Implementation may still use internal handler Modules, but callers should not need to know their ordering.

### Ordering invariants to preserve

1. `tool_execution_end` and `turn_end` recovery marker updates happen before later early returns.
2. User pending-message removal happens before the display event is emitted.
3. Assistant deobfuscation affects display emission only; persisted history remains obfuscated.
4. `#emitSessionEvent(displayEvent)` still happens before post-emit side effects that listeners expect to observe.
5. TTSR stream interruption may stop later processing for that event.
6. `message_end` persistence happens before assistant recovery marker emission.
7. Successful retry fallback emits success before retry state is cleared.
8. On `agent_end`, retry handling runs before compaction.
9. Compaction runs before todo completion checks.
10.   Tool-choice queue resolution stays at `turn_end`, not `message_end`.

### Implementation slices

1. **Characterization tests first**
   - Feed representative `AgentEvent` sequences into an `AgentSession` test fixture.
   - Assert emitted events, persisted entries, marker writes, retry calls, and compaction trigger order.

2. **Extract a no-op router shell**
   - Add the new Module with a `handle(event)` Interface.
   - Initially delegate back to the existing method body or call extracted private helpers.
   - No behavior change.

3. **Move pure routing phases**
   - Pre-event bookkeeping.
   - Display-event transformation.
   - External emission.
   - Post-event subsystem calls.

4. **Move one concern at a time**
   - Pending visible messages.
   - Streaming edit guard calls.
   - Tool-choice queue resolution.
   - Message persistence.
   - Tool-result side effects.
   - Post-turn maintenance.

5. **Shrink `AgentSession`**
   - `AgentSession` owns construction and context wiring.
   - Event knowledge moves into the router Implementation.

### Tests

- Event-order contract tests.
- TTSR interruption contract: abort schedules retry and prevents unintended later handling.
- Persistence contract: `message_end` appends the right session entry type.
- Retry-vs-compaction contract: retryable error does not compact on same turn.
- Tool-choice contract: queue resolves at `turn_end`.

### Completion criteria

- `AgentSession.#handleAgentEvent` is a thin delegator.
- The event-router Module has a small Interface and owns the ordering comments.
- Tests describe event-sequence contracts rather than private fields.

---

## 2. PostPromptRecovery scheduler

### Files

- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/retry-controller.ts`
- `packages/coding-agent/src/session/ttsr-engine.ts`
- `packages/coding-agent/src/session/recovery-driver.ts`
- `packages/coding-agent/src/session/run-bridge.ts`

### Problem

Continuation scheduling is spread across callbacks and fields:

- `#postPromptTasks`
- `#postPromptTasksPromise`
- `#schedulePostPromptTask`
- `#scheduleAgentContinue`
- `#waitForPostPromptRecovery`
- TTSR resume promises
- retry wait promises
- recovered continuation scheduling

The Interface is not “schedule safe post-prompt work�? it is “know which private field to wait on.�?That is shallow and race-prone.

### Deletion test

If the scheduler code were deleted, delayed continuation complexity would reappear in TTSR, retry, recovery, auto-continue, and compaction. The behavior is earning its keep, but it lacks a deep Module.

### Target shape

Create a PostPromptRecovery scheduler Module.

Working name: `PostPromptScheduler` or `PostPromptRecoveryQueue`.

It should own:

- delayed work
- generation guards
- cancellation
- tracked promises
- wait-for-idle orchestration
- safe `continue` scheduling

`AgentSession` should supply narrow callbacks:

- get current generation
- check streaming state
- run `AgentRunRequest`
- restore primary retry fallback before `continue`
- observe retry/TTSR gates until candidate 1/3 move those behind deeper Modules

### Implementation slices

1. **Write scheduler contract tests**
   - delayed task runs after delay
   - generation mismatch skips
   - abort cancels pending work
   - `waitForIdle` loops while retry/TTSR/post-prompt work is active
   - `scheduleContinue` restores fallback before continuing

2. **Move fields and helpers**
   - Move `#postPromptTasks*` and `#postPromptTasksAbortController` into the new Module.
   - Keep `AgentSession` method names as thin delegators for one change set.

3. **Move continuation call sites**
   - TTSR immediate retry.
   - deferred TTSR injection.
   - retry controller callback.
   - recovered continuation.
   - auto-continue prompt scheduling.

4. **Replace direct waits**
   - `AgentSession.waitForIdle()` calls scheduler Interface.
   - The scheduler coordinates retry and TTSR gates through supplied functions.

5. **Remove obsolete private fields from `AgentSession`**

### Tests

- Unit tests for the scheduler with fake callbacks.
- Session-level regression for TTSR + retry nesting.
- Regression for cancelling pending work during `dispose()`.

### Completion criteria

- `AgentSession` no longer directly owns post-prompt task sets.
- Continuation scheduling rules live in one Module.
- Races are tested through the scheduler Interface.

---

## 3. RecoveryLedger write-side

### Files

- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/recovery-marker-live.ts`
- `packages/coding-agent/src/session/recovery-policy.ts`
- `packages/coding-agent/src/session/recovery-driver.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/agent/src/run/recovery-marker.ts`
- `packages/agent/src/run/agent-run.ts`

### Problem

`RecoveryPolicy` and `RecoveryDriver` are already relatively deep read/apply Modules. The write-side marker state is still inline in `AgentSession`:

- generation counter
- event sequence counter
- pending tool-call ids
- marker emission timing

There is also a conceptual mismatch: `AgentRunController` declares a `RecoveryMarker` Layer dependency, but marker emission currently happens in `AgentSession`'s event subscription.

### Deletion test

Deleting the inline recovery marker fields would force every event handler to rediscover ADR-0003 ordering. The behavior is real. Deleting the unused `RecoveryMarker` Layer dependency may be possible, but only after confirming whether it provides actual Leverage.

### Target shape

Create a `RecoveryLedger` Module that owns the write-side state for ADR-0003.

The Module Interface should express event sequence facts, not storage details:

- observe event start
- observe assistant persisted
- observe tool completed
- observe turn completed
- append marker through a supplied Adapter

### Implementation slices

1. **Characterization tests**
   - assistant with tool calls creates pending ids after message persistence
   - tool result removes one pending id and writes marker
   - turn end clears pending ids
   - mid-stream marker is written with `isStreaming: true`

2. **Introduce `RecoveryLedger`**
   - Move generation, event sequence, and pending id state.
   - Inject a narrow writer Adapter wrapping `SessionManager.appendRecoveryMarker`.

3. **Wire through candidate 1 router**
   - The router calls the ledger at ordered points.
   - `AgentSession` no longer touches recovery marker counters directly.

4. **Resolve `RecoveryMarker` Layer question**
   - If the Layer remains load-bearing, make `RecoveryLedger` use it consistently.
   - If it is only a hypothetical Seam, propose deletion in a separate small change.

5. **Update `CONTEXT.md`**
   - Add `RecoveryLedger` if accepted as the canonical term.

### Tests

- Pure ledger tests using an in-memory writer Adapter.
- Existing `recovery-policy` tests remain unchanged.
- A reopen recovery test verifies ledger-written entries still classify to `mid-tool` without re-running tools.

### Completion criteria

- ADR-0003 write-side invariants live in one Module.
- `AgentSession` only routes events to the ledger.
- The `RecoveryMarker` Layer either earns its keep or is removed with a documented deletion-test result.

---

## 4. ContextPressure decision Module

### Files

- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/compaction/*`
- `packages/coding-agent/src/session/compaction-retry.ts`
- `packages/coding-agent/src/config/model-resolver.ts`
- `docs/compaction.md`
- `CONTEXT.md`

### Problem

`CONTEXT.md` says the compaction orchestrator intentionally stays on `AgentSession` because it crosses many session callbacks. That ADR-aware decision should stand.

But a smaller policy is still shallow inside `AgentSession`:

- overflow vs threshold decision
- pruning effect on context tokens
- context promotion before compaction
- compaction model candidate ordering
- idle compaction trigger shape

### ADR note

This must not contradict the existing `CONTEXT.md` decision that the full compaction orchestrator stays on `AgentSession`. The target is only the pure decision Module.

### Deletion test

Deleting the decision code would spread context-pressure rules across prompt sending, `agent_end`, compaction, and model promotion. It deserves a Module, but the Module should not own session mutation.

### Target shape

Create a pure `ContextPressurePolicy` Module.

Input: assistant message facts, current model, settings snapshot, available model facts, prune result, active roles.

Output: a decision such as:

- do nothing
- prune only
- promote model then continue
- compact for overflow and retry
- compact for threshold
- skip because disabled

The Adapter that mutates session state remains `AgentSession`.

### Implementation slices

1. **Extract tests around current behavior**
   - context overflow promotes before compaction
   - threshold applies pruning token savings
   - errors without overflow do not compact
   - aborted messages skip unless pre-prompt check allows them
   - candidate ordering respects role models and current model

2. **Extract pure candidate helpers**
   - model candidate ordering
   - promotion target selection
   - threshold calculation with prune result

3. **Add decision Module**
   - Keep call sites in `AgentSession`.
   - Replace nested branching with decision + apply.

4. **Keep orchestrator in place**
   - `#runAutoCompaction` remains until a later grilling round explicitly reopens the `CONTEXT.md` decision.

5. **Document the split**
   - Update `CONTEXT.md` with the accepted Module name.

### Tests

- Pure decision table tests.
- Existing compaction retry tests remain as integration coverage.
- One session-level test verifies the decision is applied correctly.

### Completion criteria

- Context-pressure policy has high Depth: many rules behind a small pure Interface.
- `AgentSession` still owns cross-session mutation.
- No ADR conflict.

---

## 5. ToolPresentation Module

### Files

- `packages/coding-agent/src/tools/renderers.ts`
- `packages/coding-agent/src/tools/render-utils.ts`
- `packages/coding-agent/src/tools/*`
- `packages/coding-agent/src/edit/renderer.ts`
- `packages/coding-agent/src/lsp/render.ts`
- `packages/coding-agent/src/task/render.ts`
- `packages/coding-agent/src/modes/components/tool-execution.ts`
- `packages/coding-agent/src/modes/rpc/wire/*`
- `apps/tui-go/internal/ui/chat/tools.go`

### Problem

Tool result presentation is coupled to legacy terminal rendering. Many built-in tools return `pi-tui` renderers directly. This blocks the pi-tui deletion path and forces tui-go to either re-render raw tool data or miss rich summaries.

The current Interface is shallow: each tool knows its own rendering details and the caller knows the renderer registry.

### Deletion test

Deleting the renderers today would remove lots of presentation behavior, but the same formatting rules would reappear in tui-go or print mode. That means the behavior should move behind a deeper presentation Module, not vanish.

### Target shape

Create neutral `ToolPresentation` data that describes what should be shown, independent of terminal rendering.

Then add Adapters:

- legacy terminal Adapter: `ToolPresentation` to `pi-tui` output
- RPC/tui-go Adapter: `ToolPresentation` to structured summary frames
- print Adapter if needed

Start with a small tool set, then migrate tool batches.

### Implementation slices

1. **Inventory current presentation patterns**
   - status line
   - output block
   - code block
   - tree/list
   - diff
   - image/sixel fallback
   - error message
   - truncation notice

2. **Define minimal presentation vocabulary**
   - Start with `bash`, `read`, and `edit` because they exercise output, file preview, and diff.
   - Keep the vocabulary small; do not mirror every `pi-tui` primitive.

3. **Build legacy Adapter**
   - Convert presentation data back to current terminal rendering.
   - Existing TUI should look unchanged.

4. **Add optional renderer path**
   - Tool renderers may expose presentation data first.
   - `ToolExecutionComponent` prefers presentation data when present, falls back to existing renderer.

5. **Expose over RPC**
   - Add optional structured summary fields only after the data contract is stable.
   - Keep OMP-RPC v1 additive.

6. **Migrate batches**
   - Batch 1: `bash`, `read`, `edit`.
   - Batch 2: search/find/ast-grep/lsp.
   - Batch 3: task/todo/python/notebook.
   - Batch 4: remaining specialized tools.

7. **Delete direct legacy dependencies from non-legacy areas**
   - Align with the pi-tui migration policy in `CONTEXT.md`.

### Tests

- Presentation data contract tests for migrated tools.
- Adapter tests for sanitization: tabs, long lines, paths, truncation.
- RPC additive-field tests once summaries are emitted.

### Completion criteria

- Tool presentation rules live in one Module.
- New tools can provide structured presentation without importing legacy rendering.
- tui-go can consume rich summaries without duplicating terminal formatting.

---

## 6. Direct RpcModelCatalog picker

### Files

- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `apps/tui-go/internal/workspace/gmp_workspace.go`
- `apps/tui-go/internal/ui/dialog/models.go`
- `apps/tui-go/internal/ui/model/ui.go`
- `apps/tui-go/internal/workspace/gmp_workspace_catalog_test.go`
- `apps/tui-go/internal/ui/dialog/models_test.go`

### Problem

ADR-0002 says `apps/tui-go` is gmp-only. `CONTEXT.md` says **Bridge Model Catalog** and **Synthetic gmp provider** are temporary Adapters. They still exist to force backend model truth into Catwalk-shaped config.

This is now a shallow Adapter: it has one consumer path and mostly translates data for inherited picker assumptions.

### Deletion test

If **Bridge Model Catalog** is deleted before changing the picker, picker complexity reappears immediately. If the picker consumes `RpcModelCatalog` directly, the bridge projection disappears without spreading complexity. That is the desired deletion-test outcome.

### Target shape

The model picker consumes `RpcModelCatalog` directly.

`GmpWorkspace` stores the latest backend catalog as backend-shaped data, not as `cfg.Providers` truth. The picker renders backend providers/models from that catalog.

### Implementation slices

1. **Add Go catalog structs**
   - Mirror the TS wire shape from `rpc-types.ts`.
   - Keep parsing in `GmpWorkspace.RefreshModelCatalog`.

2. **Store catalog directly**
   - Add direct catalog accessors on `GmpWorkspace`.
   - Keep Bridge Model Catalog temporarily for old picker path.

3. **Add picker source path**
   - `models.go` detects gmp workspace and reads direct catalog.
   - Render provider groups, availability, login state, current model, roles from `RpcModelCatalog`.

4. **Move selection handling**
   - `ui.go` uses catalog entries directly for unavailable-model login and `set_model` retry.

5. **Delete Bridge Model Catalog**
   - Remove rebuild of `cfg.Providers` from backend catalog.
   - Remove synthetic provider fallback where no longer needed.

6. **Remove backend compatibility shim only when safe**
   - `rpc-mode.ts` has a `gmp/gmp-backend` compatibility branch.
   - Delete it in a separate cleanup if no supported host still sends it.

7. **Update `CONTEXT.md`**
   - Mark **Bridge Model Catalog** and **Synthetic gmp provider** removed.

### Tests

- Go picker test renders direct backend catalog providers.
- Unavailable model selection triggers gmp auth and retries selection.
- `models.catalog` parse test preserves role and login metadata.
- TS `rpc-model-catalog.test.ts` remains source-side contract coverage.

### Completion criteria

- Picker no longer reads backend model truth through `cfg.Providers`.
- Synthetic `gmp/gmp-backend` is gone or explicitly isolated behind a short compatibility note.
- ADR-0002 direction is fulfilled for the picker.

---

## 7. Collapse gmp-only Workspace seam

### Files

- `apps/tui-go/internal/workspace/workspace.go`
- `apps/tui-go/internal/workspace/gmp_workspace.go`
- `apps/tui-go/internal/cmd/root.go`
- `apps/tui-go/internal/ui/dialog/models.go`
- `apps/tui-go/internal/ui/model/ui.go`
- `apps/tui-go/internal/ui/*_test.go`

### Problem

`Workspace.IsGmpMode()` remains even though ADR-0002 says `apps/tui-go` is gmp-only. This is a hypothetical Seam: one real Adapter remains.

The large `Workspace` Interface also makes tests implement many unrelated methods. That is shallow: the Interface exposes nearly as much complexity as the Implementation.

### Deletion test

Deleting `IsGmpMode()` should remove branches rather than spread logic. If logic spreads, candidate 6 was incomplete. Deleting the whole `Workspace` Interface today would be too large, but splitting caller-local Interfaces should concentrate test knowledge.

### Target shape

1. Remove `IsGmpMode()` from the main Workspace Interface and collapse false branches.
2. Prefer concrete `*GmpWorkspace` where the app truly requires gmp behavior.
3. Add small caller-local Interfaces only where tests or genuine variation require them.

### Implementation slices

1. **Delete `IsGmpMode` checks after candidate 6**
   - Picker no longer needs gmp-vs-legacy branching.
   - Auth dialog path is always gmp auth.

2. **Update comments and tests**
   - Remove comments that mention `AppWorkspace` or `ClientWorkspace` as live Adapters.
   - Tests stop toggling gmp mode flags.

3. **Narrow test seams**
   - For model picker tests, define only the methods the picker uses.
   - For auth flow tests, define only auth-related methods.
   - Keep these Interfaces near the caller so they do not become new global shallow Modules.

4. **Review legacy config mutation methods**
   - `SetProviderAPIKey`, `ImportCopilot`, `RefreshOAuthToken`, and related legacy methods may be vestigial.
   - Do not delete until grep proves no live caller or an ADR says they are obsolete.

5. **Shrink Workspace Interface**
   - Move toward smaller Interfaces by area: session, model catalog, auth, messages, permissions.
   - Only introduce a Seam when there are two real Adapters or a strong test seam need.

### Tests

- Go package tests for `internal/workspace`, `internal/ui/dialog`, `internal/ui/model`.
- Regression that `/login` and picker auth still use backend `auth.*` flow.
- Build check for unreachable legacy branches.

### Completion criteria

- `IsGmpMode()` is gone.
- No false gmp branch remains in live tui-go code.
- Tests use narrow caller-local Interfaces instead of fake full Workspaces.

---

## Suggested verification after each step

Run only package-local checks unless broader fallout is expected:

- TypeScript package changes: `bun check:ts`
- Go tui changes: from `apps/tui-go`, run `go test ./...`
- Cross-package RPC changes: run both the relevant TS tests and Go tests

Do not run full `bun test` unless explicitly requested.

## Documentation updates by step

| Step | Docs to update                                                                         |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | `CONTEXT.md` if `AgentEventRouter` becomes canonical                                   |
| 2    | `CONTEXT.md` if `PostPromptScheduler` becomes canonical                                |
| 3    | `CONTEXT.md`; possibly an ADR if deleting or changing `RecoveryMarker` Layer semantics |
| 4    | `CONTEXT.md`, `docs/compaction.md`                                                     |
| 5    | `CONTEXT.md`, `docs/tui.md`, custom tool rendering docs                                |
| 6    | `CONTEXT.md`, ADR-0002 follow-up note if compatibility shim is removed                 |
| 7    | `CONTEXT.md`, ADR-0002 implementation notes if the gmp-only carve-out is completed     |

## First implementation recommendation

Start with candidate 1, but keep the first change intentionally small:

1. Add characterization tests for `#handleAgentEvent` ordering.
2. Add router shell.
3. Move only pending-message removal, display-event transformation, and external emission.
4. Stop before moving TTSR or persistence.

That gives fast feedback without risking the dense TTSR/retry/compaction paths on the first pass.
