# Compaction Application Design

Status: approved, implemented, and verified

Scope: `packages/coding-agent` session-history application and append preflight correctness

## Decision summary

Deepen `AgentSession` in place around the ordered application of a successful compaction. Both manual and automatic compaction will call one private `#applyCompaction(...)` module, and compaction plus successful tool-output pruning will share one private `#rebuildAfterHistoryRewrite()` module. No exported module, TypeScript interface, or Adapter is added.

Use the entry ID already returned by `SessionManager.appendCompaction()` to retrieve the exact `CompactionEntry`. Never re-find a saved compaction by summary text.

Before any append mutates `SessionManager`'s in-memory entries, index, leaf, or usage state, run a private persistence-error preflight. `branchWithSummary()` must not move the leaf before that protected append succeeds.

## Problem

Manual and automatic compaction currently duplicate the same result-application sequence in `AgentSession`:

1. append a `CompactionEntry`;
2. rebuild display context;
3. replace live agent messages;
4. synchronize todo phases;
5. close Codex provider history;
6. find a saved compaction by matching its summary;
7. emit `session_compact`.

This has two correctness problems and one design problem.

First, summary text is not an identity. If two compactions have identical summaries, `getEntries().find(...)` can select the older entry. The post-compaction event then reports an entry other than the one just appended.

Second, `SessionManager.#appendEntry()` currently mutates `#fileEntries`, `#byId`, and `#leafId` before `_persist()` checks the append log's sticky error. A prior asynchronous persistence failure can therefore make a later append throw after partially advancing in-memory history. `branchWithSummary()` widens this failure mode by assigning `#leafId = branchFromId` before it calls `#appendEntry()`.

Third, the ordered reconciliation contract is duplicated across the manual and automatic paths. The order is load-bearing, but its Interface is currently “know and reproduce every step.” This reduces locality and makes tests more likely to cover one path while missing drift in the other.

## Domain term

**Compaction application** is the transition in which an accepted `CompactionResult` becomes the active session history.

It starts when `AgentSession` asks `SessionManager` to append that result and ends after live messages, todo phases, and provider history have been reconciled and the exact saved entry has been offered to the `session_compact` hook.

Compaction application is distinct from:

- compaction preparation and summary generation;
- extension customization;
- automatic model selection and retry;
- post-compaction continuation scheduling;
- durable completion of the queued session write.

This term should be added to `CONTEXT.md` when the implementation lands. It sharpens an existing operation rather than changing a cross-system decision, so no ADR is required.

## Goals

- Report the exact newly appended compaction entry, even when summaries repeat.
- Give manual and automatic compaction one ordered result-application implementation.
- Keep post-history-rewrite reconciliation local and shared with successful pruning.
- Prevent a previously latched persistence failure from partially mutating a later append.
- Preserve all existing compaction generation, retry, hook, continuation, and queued-durability behavior.
- Verify behavior through existing public session and storage seams.

## Non-goals

- Extract the full mutating compaction orchestrator from `AgentSession`.
- Add an exported module, a new TypeScript interface, or an Adapter.
- Change `CompactionResult`, `CompactionEntry`, or `appendCompaction()`'s public Interface.
- Change manual preparation, extension hooks, automatic candidate selection, retry, handoff, abort, or auto-continue policy.
- Add `flush()`, `fsync()`, or synchronous durability to compaction application.
- Make tool-output pruning atomic. Its mutation-before-rewrite risk remains separate work.
- Combine compaction append and pruning rewrite behind a generic tagged transaction.
- Change the behavior of `ProviderSessionPool.closeForCodexHistoryRewrite()`.

## Chosen design

### Placement and private Interfaces

Keep orchestration on `AgentSession`, consistent with the existing `CONTEXT.md` decision. Add two private modules:

```ts
async #applyCompaction(result: CompactionResult, fromExtension: boolean): Promise<void>
#rebuildAfterHistoryRewrite(): void
```

`#applyCompaction(...)` owns compaction-specific persistence identity and notification. Its private Interface contains only the accepted result and the existing `fromExtension` fact.

`#rebuildAfterHistoryRewrite()` owns the common post-success reconciliation sequence:

1. build active display context with `buildDisplaySessionContext()`;
2. replace live agent messages with that context's messages;
3. synchronize todo phases from the active branch;
4. close Codex provider history for the current model.

The reconciliation module is called only after the relevant history operation has succeeded. It earns depth because compaction application and pruning both need the same ordered behavior.

### Exact compaction-application order

`#applyCompaction(result, fromExtension)` must perform these steps in order:

1. Call `SessionManager.appendCompaction(...)`, mapping every field from the accepted result without alteration:
   - `summary`
   - `shortSummary`
   - `firstKeptEntryId`
   - `tokensBefore`
   - `details`
   - `preserveData`
   - plus the separate `fromExtension` fact
2. Retain the returned entry ID.
3. Resolve that ID with `SessionManager.getEntry(id)` and narrow with `entry?.type === "compaction"`.
4. Call `#rebuildAfterHistoryRewrite()`.
5. If the extension runner and narrowed exact entry are present, await `session_compact` with that entry and the same `fromExtension` value.

There is no `getEntries().find(...)`, summary comparison, `as CompactionEntry` assertion, or textual fallback. Entry identity comes exclusively from the ID returned by the append.

### Manual data flow

The manual `compact(...)` method retains ownership of its existing orchestration:

1. reject overlapping compaction;
2. disconnect from the agent and abort current work;
3. validate model and key availability;
4. prepare the active branch;
5. run the existing pre-compaction extension hooks;
6. accept a hook-provided result or generate a result;
7. preserve the existing `preserveData` merge behavior;
8. reject an aborted compaction;
9. assemble the complete `CompactionResult`;
10. await `#applyCompaction(result, fromExtension)`;
11. call `options.onComplete` and return that same result.

The existing catch, `onError`, abort-controller cleanup, and agent reconnection behavior remain unchanged.

### Automatic data flow

The automatic path retains ownership of pressure-policy application and scheduling:

1. prepare compaction and run the existing extension hooks;
2. accept a hook-provided result or select candidates and run the existing retry loop;
3. preserve the existing `preserveData` merge behavior;
4. emit the existing aborted `auto_compaction_end` and return when aborted;
5. assemble the complete `CompactionResult`;
6. await `#applyCompaction(result, fromExtension)`;
7. emit successful `auto_compaction_end` with that same result;
8. retain the existing auto-continue, retry continuation, and queued-message scheduling behavior.

Therefore `session_compact` still occurs before successful `auto_compaction_end`, and both occur only after live-history reconciliation.

## SessionManager append preflight

Add a private persistence-error preflight and invoke it at the start of `#appendEntry()`, before any mutation of:

- `#fileEntries`;
- `#byId`;
- `#leafId`;
- usage statistics.

The preflight must preserve the current persistence conditions: it is a no-op when persistence is disabled or no session file is active, and it throws the append log's existing sticky error for an active persistent session. The existing persistence path may reuse the same private check; the required invariant is that `#appendEntry()` checks before mutation.

This change protects every `append*` method without expanding their Interfaces.

### `branchWithSummary()`

Keep the existing branch target validation and construct the new entry with:

- `parentId: branchFromId`;
- `fromId: branchFromId ?? "root"`.

Remove the early `#leafId = branchFromId` assignment. `#appendEntry()` advances the leaf to the new branch-summary entry only after its preflight succeeds. If the preflight throws, both the previous leaf and the entries remain unchanged.

The public `branchWithSummary()` return type and successful behavior do not change.

## Error and durability semantics

Compaction application remains accepted-but-not-yet-durable:

- If an earlier persistence error is already latched, the append throws before in-memory mutation. `AgentSession` does not rebuild live state or emit `session_compact`.
- If no error is latched, the append updates in-memory history and queues persistence as it does today. Compaction application proceeds after that accepted append.
- A new asynchronous write failure can still occur after acceptance. It remains latched by the append log and is surfaced by `flush()` or a later protected append.
- No new `flush()` or `fsync()` call is added to the application path, and no queued write is described as durable before the existing persistence module confirms it.
- Non-persistent sessions retain their current in-memory behavior.

The preflight fixes partial mutation after a known failure; it does not redefine asynchronous append as a transaction.

## Pruning distinction

`#pruneToolOutputs()` may call `#rebuildAfterHistoryRewrite()` only after `rewriteEntries()` resolves successfully. It must not emit `session_compact`.

Pruning and compaction remain different operations:

| Concern | Compaction application | Tool-output pruning |
| --- | --- | --- |
| History operation | Append a new identified entry | Mutate prunable entries, then rewrite |
| Success identity | Returned compaction entry ID | Prune count and tokens saved |
| Notification | `session_compact` | None |
| Reconciliation | Shared post-rewrite module | Shared post-rewrite module |
| Atomicity in this change | Known-error preflight on append | Unchanged |

Pruning currently mutates live entries before `rewriteEntries()` can fail. This design does not hide or repair that behavior. Solving it requires a persistence-level design that stages or rolls back rewritten entries and belongs to the separate persistence-deepening candidate.

A generic “history rewrite transaction” would conflate two different identities, durability paths, error contracts, and notifications. Its Interface would expose tags and callbacks that callers already know, reducing depth rather than increasing it.

## Architecture rationale

### Depth

The private `#applyCompaction` Interface hides the ordered mapping, exact-entry identity, reconciliation, and notification contract behind two inputs. `#rebuildAfterHistoryRewrite` hides four ordered live-state operations behind no parameters.

### Locality

The exact-entry rule and application order live in one place. A change to todo synchronization, provider closure, or event timing no longer requires parallel edits in manual and automatic compaction.

### Leverage

Both compaction callers use the same application module. Compaction and pruning use the same post-success reconciliation module. Tests can exercise the behavior through the existing `AgentSession` and `SessionManager` Interfaces.

### Deletion test

Deleting `#applyCompaction` would spread the identity and ordering rules back across both compaction callers. Deleting `#rebuildAfterHistoryRewrite` would spread reconciliation across compaction and pruning. Both modules therefore concentrate real complexity.

### Seam and Adapter discipline

The established external seam is `AgentSession`; the new modules are private implementation seams. There is one behavior and no runtime variation, so a new Adapter would be hypothetical. A new exported interface would make callers learn compaction-application ordering that `AgentSession` already has enough context to own.

This preserves the accepted `CONTEXT.md` decision that the full mutating compaction orchestrator stays on `AgentSession`, where its many session dependencies and continuation feedback loop already live.

## Public-seam test plan

### AgentSession integration contract

Add `packages/coding-agent/test/agent-session-compaction-application.test.ts`.

Use `createAgentSession`, an inline extension factory, `SessionManager.inMemory()`, isolated settings, auth storage, and a bundled model. Do not access private fields, use `any`, or use `mock.module()`.

Cover these contracts:

1. **Manual same-summary identity**
   - Have `session_before_compact` return a fixed summary.
   - Compact twice with an intervening compactable turn.
   - Capture both `session_compact` events.
   - Assert the second event carries a different ID from the first, and its ID equals `sessionManager.getLeafId()`.

2. **Manual application order**
   - Before compaction, make live messages, todo phases, and Codex provider history observably stale relative to persisted branch state.
   - In the `session_compact` handler, capture immutable snapshots or booleans for:
     - `session.messages` and `session.buildDisplaySessionContext().messages`;
     - `session.getTodoPhases()` and the expected active-branch phases;
     - whether the `openai-codex-responses` provider session was closed and removed;
     - the event entry ID and current leaf ID.
   - Assert those captured observations only after `compact()` returns. `ExtensionRunner.emit()` isolates handler failures, so an assertion thrown inside the handler would not fail the test.
   - The post-return assertions prove reconciliation had completed when notification occurred, through public seams.

3. **Automatic parity and same-summary identity**
   - Reuse the established `triggerAutoCompaction` event pattern.
   - Wait for `auto_compaction_end` rather than timing assumptions.
   - Run two automatic compactions with the same hook-provided summary and an intervening compactable turn.
   - Have `session_compact` capture the same immutable ordering snapshots as the manual path, then assert them after `auto_compaction_end` has completed.
   - Assert that the second event has a different ID from the first and that its captured ID equals the captured current leaf ID.

4. **Field preservation**
   - Include `shortSummary`, `details`, and `preserveData` in a hook-provided result.
   - Capture the exact emitted entry and `fromExtension` in the handler, then assert after compaction returns that every field was preserved without changing `CompactionResult`'s shape.

### SessionManager persistence contract

Add `packages/coding-agent/test/session-manager/append-persistence-error.test.ts` using a `RenameFailStorage` subclass of `MemorySessionStorage`.

1. Create a persistent `SessionManager` with the failing storage.
2. Induce an atomic rewrite failure and observe the failure through `flush()` so the append log holds a sticky error.
3. Snapshot `getEntries()` and `getLeafId()`.
4. Attempt a normal append and assert it throws while entries and leaf remain exactly unchanged.
5. Repeat the invariant with `branchWithSummary(...)` and assert the original leaf is preserved exactly; merely proving that the leaf did not become `branchFromId` is insufficient.

The test defends public state transitions, not the private preflight's name or call count.

### Focused verification

Run only the relevant tests and project gate:

```sh
bun test packages/coding-agent/test/agent-session-compaction-application.test.ts
bun test packages/coding-agent/test/agent-session-auto-compaction-x-initiator.test.ts
bun test packages/coding-agent/test/session-manager/append-persistence-error.test.ts
bun check
```

Do not run the full `bun test` suite unless explicitly requested.

## Documentation and changelog plan

When implementation is authorized:

- `CONTEXT.md`
  - Define **Compaction application**.
  - Record that the common application tail and post-history-rewrite reconciliation are private `AgentSession` modules.
  - Keep the existing decision against extracting the full mutating orchestrator.
- `docs/compaction.md`
  - Document exact returned-ID lookup.
  - Document the full reconciliation and notification order.
  - State that append acceptance is queued, not a durability guarantee.
  - Distinguish compaction application from pruning and its unresolved atomicity.
- `docs/session.md`
  - Document that an append rejects an already-latched persistence error before mutating in-memory history.
  - Preserve the distinction between accepted asynchronous writes and durable completion through `flush()`.
- `packages/coding-agent/CHANGELOG.md`, under `## [Unreleased]` / `### Fixed`
  - Record that repeated-summary compactions emit the exact new entry.
  - Record that a latched persistence failure no longer advances in-memory history.

Do not add an ADR. Do not modify a released changelog section.

## Acceptance criteria

- Manual and automatic compaction use one private application module.
- Both paths assemble and return or emit the same complete `CompactionResult` they apply.
- `appendCompaction()` retains its existing public Interface and returned string ID.
- `session_compact.compactionEntry.id` is the exact ID returned by the current append, including when an older entry has the same summary.
- Application order is append, exact-entry resolution, message rebuild/replacement, todo synchronization, provider-history closure, then `session_compact`.
- `session_compact` remains before successful `auto_compaction_end`.
- No `as CompactionEntry` assertion or summary-based saved-entry lookup remains in either path.
- All `CompactionResult` fields, `preserveData` merge behavior, and `fromExtension` behavior are preserved.
- A sticky persistence error is checked before append mutation.
- A failed protected append leaves entries, index-visible lookups, leaf, and usage statistics unchanged.
- `branchWithSummary()` does not move the leaf before its append succeeds.
- Newly queued persistence remains asynchronous; no `flush()` or `fsync()` is added to compaction application.
- Successful pruning reuses only post-history-rewrite reconciliation, emits no `session_compact`, and retains its current atomicity semantics.
- No exported module, new TypeScript interface, Adapter, prompt, dynamic import, `ReturnType<>`, `any`, or visibility keyword is introduced.
- Focused contract tests and `bun check` pass.
- No commit is created without explicit user instruction.

## Implementation sequence

1. Add the same-summary and hook-time reconciliation tests for manual compaction.
2. Add automatic parity coverage using the existing `auto_compaction_end` trigger pattern.
3. Add the `SessionManager` sticky-error tests, including `branchWithSummary()`.
4. Add the private persistence-error preflight at the start of `#appendEntry()` and remove the early leaf assignment from `branchWithSummary()`.
5. Add `AgentSession.#rebuildAfterHistoryRewrite()` and replace the post-success reconciliation in pruning.
6. Add `AgentSession.#applyCompaction(...)`, use the returned ID plus `getEntry()`, and replace both duplicated compaction tails.
7. Remove imports or assertions made obsolete by exact type narrowing.
8. Run the focused tests, then `bun check`.
9. Update `CONTEXT.md`, `docs/compaction.md`, `docs/session.md`, and the unreleased changelog as described above.
10. Review the final diff for preserved orchestration, durability semantics, unrelated worktree changes, and accidental public-surface growth.
