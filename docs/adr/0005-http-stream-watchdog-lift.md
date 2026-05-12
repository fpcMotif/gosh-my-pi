# ADR 0005: Lift the `LocalAbort` watchdog into `HttpShape.requestStream`

## Status

Proposed — 2026-05-08. Drafted after P4a wired `runWithLocalAbortWatchdog`
through `openai-responses.ts` and `openai-completions.ts` and a third
streaming provider (`openai-codex-responses.ts`) surfaced architectural
mismatches that block the same per-provider helper from being applied
mechanically. Closes the explicit follow-up reservation in
[ADR-0004](./0004-provider-abort-taxonomy-effect-race-not-tracker.md)
§Consequences ("if the watchdog logic ends up duplicated across three
providers, lifting it into `HttpShape` is a sensible follow-up").

Finalised when P4d (codex migration onto the new `HttpShape.requestStream`)
lands; P4e/P4f are mechanical follow-ups that retarget the other two
providers and delete `runWithLocalAbortWatchdog` from
`packages/ai/src/utils/abort-effect.ts` once it has no public callers.

## Context

`runWithLocalAbortWatchdog` (`packages/ai/src/utils/abort-effect.ts`,
introduced by P4a) bundles four primitives every streaming provider needs:

- A per-call `AbortController` whose signal threads into the underlying
  `fetch` / OpenAI SDK call.
- An `Effect.raceFirst` between the SSE consumption and a first-event
  watchdog Effect (`Effect.sleep` → `Effect.fail(LocalAbort)`).
- An idle-timeout rewrap from the `STREAM_STALLED_SUFFIX`-bearing throw
  out of `iterateWithIdleTimeout` into `LocalAbort({ kind: "idle" })`.
- A scope finalizer that aborts the underlying fetch on any non-success
  exit (caller interrupt, watchdog win, body throw).

P4a's two consumers (`openai-responses.ts`, `openai-completions.ts`) each
wired it in ~30 lines. The third streaming provider,
`openai-codex-responses.ts`, threads its own merged
`AbortSignal.any([options.signal, requestAbortController.signal])` plus a
`requestSetup: { requestAbortController, requestSignal, wrapCodexSseStream }`
bundle through ~80 lines of retry/websocket/tool-call glue
(`packages/ai/src/providers/openai-codex-responses.ts:398-411`, plus
~10 downstream uses of `requestSetup.requestSignal`). Naively wrapping
the SSE consumption in `runWithLocalAbortWatchdog` creates a duplicate
abort source (the helper's per-call controller AND codex's existing
`requestAbortController` would both want to abort the underlying fetch),
with no single source of truth for the SDK call's signal.

The `Http` service (`packages/ai/src/layers/http.ts`, P1) today exposes
only `request: (input, init) => Effect<Response, HttpError>` for
non-streaming use cases (codex model discovery). Streaming providers
bypass it entirely — they call the OpenAI SDK directly, then iterate the
resulting AsyncGenerator.

## Decision

`Http` gains a `requestStream` method:

```ts
interface HttpShape {
    readonly request: (input: RequestInfo, init?: RequestInit) =>
        Effect.Effect<Response, HttpError>;
    readonly requestStream: <T>(opts: {
        readonly callerSignal?: AbortSignal;
        readonly firstEventWatchdog?: {
            readonly kind: "timeout" | "idle" | "stall";
            readonly timeoutMs: number;
        };
        readonly body: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
    }) => Effect.Effect<AsyncIterable<T>, LocalAbort | unknown>;
}
```

`requestStream` owns: the per-call `AbortController`, the
`effectFromSignal` bridge for caller interrupt, the first-event
watchdog Effect, the `STREAM_STALLED_SUFFIX` rewrap, and the scope
finalizer that aborts the underlying fetch. Providers consume it:

```ts
const events = yield* http.requestStream({
    callerSignal: options?.signal,
    firstEventWatchdog: { kind: "timeout", timeoutMs },
    body: signal => client.chat.completions
        .create(params, { signal })
        .withResponse()
        .then(({ data }) => data),
});
for await (const event of events) { /* ... */ }
```

`LiveHttp` implements `requestStream` by inlining the existing
`runWithLocalAbortWatchdog` body. The helper file
(`packages/ai/src/utils/abort-effect.ts`) becomes a private module behind
`Http`; `runWithLocalAbortWatchdog` ceases to be a public export.

Migration order:

1. **P4d** — define `HttpShape.requestStream` + `LiveHttp.requestStream`;
   migrate `openai-codex-responses.ts` first (most complex consumer;
   forces the design to handle real-world abort/retry edge cases); keep
   codex's `requestSignal` for non-fetch operations (retry sleeps,
   websockets) and the helper-owned signal for the fetch only.
2. **P4e** — retarget `openai-responses.ts` and `openai-completions.ts`
   from `runWithLocalAbortWatchdog` directly to `http.requestStream`.
   Mechanical: drop the `import { runWithLocalAbortWatchdog }` and
   replace with the `Http` service consumer pattern.
3. **P4f** — delete `runWithLocalAbortWatchdog` from
   `packages/ai/src/utils/abort-effect.ts`. Move its tests onto the new
   `Http.requestStream` contract. Update ADR-0004's link to point at
   the new location.

## Considered options

- **Keep `runWithLocalAbortWatchdog` as a per-provider helper.** Status
  quo from P4a. Rejected: codex's complications (merged signal, retry
  sleeps, websockets) mean each new consumer pays the same architectural
  surcharge; lifting the watchdog into transport amortizes it across
  all current and future providers and removes the duplicate-source
  hazard.
- **Migrate codex's SSE iteration only — leave `requestSetup` intact.**
  Wrap just the SSE loop in `runWithLocalAbortWatchdog`, keep codex's
  existing merged signal for everything else. Rejected: the helper's
  per-call controller and codex's `requestAbortController` both want to
  abort the underlying fetch; semantics about which is canonical get
  confusing; the migration "succeeds" but doesn't actually remove the
  duplication ADR-0004 §Consequences flagged.
- **Effect-end-to-end refactor of providers.** Rewrite the streaming
  pipeline (`runEffectStream` + AssistantMessageEventStream + AsyncGenerator)
  as one Effect program with `Stream<T>` end-to-end. Rejected for now:
  out of scope of this ADR; `HttpShape.requestStream` is the smaller
  step that doesn't require pipeline rewrite. May become attractive
  once Effect's `Stream` is the canonical streaming primitive across
  the workspace.

## Consequences

- Codex's `requestSetup` shrinks. The merged `AbortSignal.any` and the
  fetch-side `requestAbortController` move behind `Http`. Codex's retry
  sleeps and websockets continue to use a bespoke abort path — those are
  orthogonal concerns from `HttpShape.requestStream`'s perspective and
  stay out of scope for this ADR.
- The `Http` service surface grows from one method to two. Non-streaming
  callers still use `request` exclusively (codex model discovery, etc.).
- `openai-responses.ts` and `openai-completions.ts` shed ~10 lines each
  as the per-call AbortController + `Effect.tryPromise` signal forwarding
  move into `LiveHttp.requestStream`.
- The `Http` Layer becomes the single source of truth for
  "fetch + watchdog + AbortController hygiene". Any future provider
  gets these for free.
- Open question for P4d: `requestStream`'s return type. Three candidates —
  `Effect<AsyncIterable<T>, ...>` (matches today's imperative `for await`),
  `Effect<Stream<T, ...>, ...>` (Effect-native), or `Stream<T, ...>`
  directly (most ergonomic but locks providers into Effect's Stream API).
  This ADR commits to `AsyncIterable<T>` for P4d minimum-disruption; a
  future ADR can revisit if/when `runEffectStream` becomes canonical.
