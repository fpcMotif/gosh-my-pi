# ADR 0004: Provider abort taxonomy uses Effect.race + LocalAbort, not AbortSourceTracker

## Status

Proposed — 2026-05-08. Drafted in P3a (Effect-TS-v4 migration prologue),
finalised when P4a (Http Layer adoption for `openai-responses.ts` and
`openai-completions.ts`) lands.

## Context

`packages/ai/src/utils/abort.ts` exposes `createAbortSourceTracker`, a
Promise-API helper that the streaming providers call to merge a caller's
`AbortSignal` with a provider-local `AbortController`. The tracker
distinguishes two abort sources at the catch-error boundary:

- **Caller-initiated** — `tracker.wasCallerAbort() === true`. The user (or
  the agent loop's orchestrator) called `controller.abort()`. Surfaces as
  `stopReason: "aborted"` on the assistant message.
- **Provider-local** — `tracker.getLocalAbortReason() !== undefined`. The
  request stalled (no first event within budget, idle past inter-event
  threshold, TLS handshake failed). Surfaces as `stopReason: "error"`
  with a typed message.

This distinction is load-bearing for the UI: a stalled stream must not
appear as "user cancelled" because the user did not cancel.

The tracker pattern is also pre-Effect. As P4a moves the streaming
providers behind the `Http` Layer (`packages/ai/src/layers/http.ts`,
introduced in P1), the abort taxonomy needs a home in the Effect channel
so providers can fail with typed errors instead of throwing strings the
caller has to inspect.

## Decision

P4a retires `createAbortSourceTracker` in favour of:

1. A new tagged error
   [`LocalAbort`](../../packages/agent/src/errors.ts) — `kind: "timeout" |
"idle" | "stall"` plus `durationMs`. Lives in the agent runtime's
   tagged-error tree alongside `ProviderHttpError`, `UsageLimitError`,
   etc.
2. `Effect.race` at the provider boundary: the streaming Effect program
   races the SSE response stream against an `effectFromSignal(callerSignal)`
   Effect (defined in `packages/utils/src/effect-signal.ts`, P3a) and an
   idle/stall watchdog Effect. The first to fire decides the failure
   shape:
   - Caller signal wins → fiber interrupts → Promise rejects with
     Effect's interrupt cause; catch boundary maps to `stopReason: "aborted"`.
   - Watchdog wins → Effect fails with `LocalAbort({ kind, durationMs })`;
     catch boundary maps to `stopReason: "error"` with the typed kind
     visible in `errorKind`.
3. `errorToKind` (`packages/agent/src/error-kind.ts`, P3a) maps
   `LocalAbort → { kind: "transient", reason: "transport" }` so the
   downstream UI / retry logic treats stalled streams as transient.
   Caller aborts surface through Effect's interrupt channel and never
   pass through `errorToKind`.

P4a deletes `createAbortSourceTracker` and updates every consumer
(`openai-responses.ts`, `openai-completions.ts`, `kimi.ts`'s adapter
chain) in the same PR. No grace period: the helpers replace it
verbatim at the catch-error boundary.

## Considered options

- **Keep `AbortSourceTracker`, wrap externally.** Effect Stream sits
  outside the existing tracker; the catch-error boundary still reads
  `tracker.wasCallerAbort()`. Rejected: defers the typed-error win
  indefinitely, leaves a Promise-API helper threading through every
  provider Effect, and continues to require manual stopReason wiring at
  every error site.
- **Move tracker into `HttpShape`.** `Http` service exposes a
  `requestWithAbortTracking` returning an Effect with the tracker as a
  typed channel. Rejected: most callers don't need the tracker; coupling
  the abort taxonomy to the Http service surface is overfitting. The
  taxonomy is provider-specific concern, not transport-specific.
- **Lose the caller/local distinction.** Effect interrupts collapse both
  cases into one signal; `stopReason` always becomes `"aborted"`.
  Rejected: regression in UI fidelity. Users see "aborted" when they
  didn't abort.

## Consequences

- Providers fail with typed `LocalAbort` errors that the agent runtime's
  retry / UI layers can introspect without parsing strings.
- The tagged-error tree gains a leaf type (`LocalAbort`) that exists
  _only_ for transport-layer cancellation; this is intentional and
  documented in CONTEXT.md.
- `effectFromSignal` and `signalFromFiber` in
  `packages/utils/src/effect-signal.ts` become the canonical workspace
  bridge — every provider, every long-running Effect program, hits this
  one helper rather than rolling its own listener bookkeeping.
- A future `HttpShape.requestStream` method that bakes the watchdog
  semantics inside the Http service is **not** blocked by this ADR —
  this ADR scopes the _taxonomy_, not the watchdog implementation
  surface. If the watchdog logic ends up duplicated across three
  providers, lifting it into `HttpShape` is a sensible follow-up.
