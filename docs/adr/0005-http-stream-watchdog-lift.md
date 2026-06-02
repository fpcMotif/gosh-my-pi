# ADR 0005: Lift the streaming abort+watchdog into HttpShape.requestStream

## Status

Proposed — 2026-05-11. Drafted in P4d (codex provider migration);
finalised when P4f deletes the per-provider tracker plumbing.

## Context

ADR-0004 settled the *taxonomy* — provider-local cancellations surface as
`LocalAbort({kind: "timeout" | "idle" | "stall"})` raised through
`Effect.race`, while caller-initiated cancellations surface through
Effect's interrupt channel via
[`effectFromSignal`](../../packages/utils/src/effect-signal.ts). The
*wiring*, however, was left to each streaming provider. As of HEAD
(May 2026), [`openai-responses.ts`](../../packages/ai/src/providers/openai-responses.ts),
[`openai-completions.ts`](../../packages/ai/src/providers/openai-completions.ts),
and [`openai-codex-responses.ts`](../../packages/ai/src/providers/openai-codex-responses.ts)
each open-code their own variant of:

1. Build a per-call `AbortController`.
2. Merge it with the caller signal via `AbortSignal.any` (responses /
   completions / codex all use `createAbortSourceTracker` for this).
3. Construct a `firstEventWatchdog` via `createWatchdog(...)` and pass
   it into `iterateWithIdleTimeout` (responses + completions only —
   codex omits this; see below).
4. After the SSE iterator finishes, distinguish caller-abort from
   local-abort by comparing `requestSignal.reason` to a captured local
   abort reason (`tracker.wasCallerAbort()`).

This duplication has produced three concrete bugs:

- **Bug 1 — `LocalAbort` lives in `@oh-my-pi/pi-agent-core` but should
  be raised by `@oh-my-pi/pi-ai`.** `pi-agent-core` already depends on
  `pi-ai`; the providers cannot import `LocalAbort` back without
  creating a cycle, so ADR-0004's typed-error story has no symbol to
  fail with on the ai side.
- **Bug 2 — `wasCallerAbort()` has a same-tick race.** `AbortSignal.any`
  picks the first underlying signal that aborted by listener order, not
  by happens-before order. A stalled stream the user cancels in the
  same microtask is reported as `stopReason: "aborted"`, hiding a real
  reliability problem.
- **Bug 3 — codex has no first-event timeout.** The other two providers
  cap the first-event wait via `getStreamFirstEventTimeoutMs`. Codex's
  `wrapCodexSseStream`
  ([openai-codex-responses.ts:403-411](../../packages/ai/src/providers/openai-codex-responses.ts#L403-L411))
  passes only `idleTimeoutMs`, so a codex turn whose upstream never
  produces the first byte hangs for the full 120 s default — and a
  TLS/handshake stall *before* the iterator is constructed has no upper
  bound at all.

The Http Layer
([packages/ai/src/layers/http.ts](../../packages/ai/src/layers/http.ts))
already owns the fetch boundary for codex model discovery. It is the
natural home for the abort-and-watchdog Effect race.

## Decision

Add a second method to `HttpShape`:

```ts
requestStream: <T>(opts: HttpStreamOpts<T>) => Effect.Effect<AsyncIterable<T>, LocalAbort>;
```

The Layer owns a per-call `AbortController` and threads its signal into
a body callback the caller supplies. The returned `Effect` resolves
when the stream *opens* (the body promise has produced an iterable);
the caller iterates with `for await` and the idle watchdog is baked
into the iterable's `next()` so it stays live during external
iteration. Three concrete consequences:

1. The merged `AbortSignal.any` pattern goes away. Caller signal,
   watchdog, and fetch each have their own controller; the first to
   abort wins via `Effect.raceFirst`, and the result is an exit type
   (success / fail / interrupt) that the caller pattern-matches
   without having to reconstruct ordering after the fact.
2. `LocalAbort` moves to `packages/ai/src/errors.ts`.
   `packages/agent/src/errors.ts` re-exports it so `AgentTaggedError`
   keeps the same shape and `errorToKind`'s exhaustive switch is
   undisturbed.
3. The first-event watchdog becomes mandatory at the Http boundary,
   with `firstEventWatchdog?: { kind, timeoutMs }` defaulting to
   `getStreamFirstEventTimeoutMs(idleTimeoutMs)`. Codex inherits this
   for free.

P4d migrates only `openai-codex-responses.ts`. P4e migrates the other
two providers; P4f deletes `runWithLocalAbortWatchdog` and
`createAbortSourceTracker` once all three providers consume
`Http.requestStream` directly.

## Considered options

- **Leave the wiring per-provider, ship only `LocalAbort` + helper.**
  Rejected: Bug #3 stays unfixed forever (each provider has to remember
  to install the first-event watchdog), Bug #2 stays unfixed (each
  provider keeps its own merged signal).
- **Wrap only the iterable, leave the fetch outside Http.** Then the
  watchdog can fire *during* iteration but the open-promise has its
  own ad-hoc timeout. Rejected: fragments AbortController ownership
  again — the iterable wrapper would not know which controller to
  abort on idle.
- **Push the watchdog into `iterateWithIdleTimeout` itself and have
  providers keep their own per-call controllers.** Rejected: couples a
  pure streaming utility to Effect's failure channel, and does not
  address the open-promise (handshake) leg of Bug #3.
- **Make `Http.requestStream` return an `Effect.Effect<void, LocalAbort>`
  that consumes the iterable internally and pushes events into a
  caller-supplied sink.** Rejected: forces every provider to flip its
  event-processing loop inside-out; preserves all the current `for await`
  loops in providers means the migration is a one-line delta per loop.

## Consequences

- Providers no longer carry watchdog wiring; they describe their stream
  intent (idle timeout, first-event budget, label) and let the Layer
  enforce it.
- `runWithLocalAbortWatchdog` becomes a public helper during the
  P4d-P4f window so non-codex providers can adopt the typed-error
  failure mode incrementally without waiting for the full Layer
  migration.
- The Http service surface grows from a 23-line interface to a ~50-line
  interface; the Live Layer now constructs both methods. The
  `makeHttpLayer(fetchFn)` test seam keeps the same signature — the
  streaming method's seam is the caller-supplied body callback, not
  `fetchFn`, because the body owns its own fetch (codex calls
  `fetchWithRetry`, openai SDK uses its own client).
- WebSocket transport (codex's preferred path on initial turns) does
  *not* flow through `Http.requestStream` — it is not an HTTP request,
  it has its own retry/reconnect lifecycle, and ADR-0005 explicitly
  scopes the consolidation to HTTP. WebSocket consolidation is a
  candidate follow-up.
