# Plan: P4d — HttpShape.requestStream + codex provider migration

Branch base: `claude/adr-0005-http-stream-watchdog` (to be created as a stub
holding ADR-0005 + the helper). This plan replaces the user-supplied brief,
which referenced files that do not yet exist (no `runWithLocalAbortWatchdog`,
no `STREAM_STALLED_SUFFIX`, no `packages/ai/src/errors.ts`, no ADR-0005, and
P4a has not landed — `createAbortSourceTracker` is still live in all three
providers). The plan therefore covers ADR-0005 + the helper + the codex
migration in one go ("option 1" from the clarification turn).

> Status of the world the plan is starting from (verified against HEAD):
>
> | Symbol / file                              | Exists? | Notes                                                            |
> | ------------------------------------------ | ------- | ---------------------------------------------------------------- |
> | `docs/adr/0005-http-stream-watchdog-lift`  | no      | ADRs end at 0004                                                 |
> | `packages/ai/src/utils/abort-effect.ts`    | no      | Only `abort.ts` exists, with `createAbortSourceTracker`          |
> | `runWithLocalAbortWatchdog`                | no      | Not anywhere in the workspace                                    |
> | `STREAM_STALLED_SUFFIX`                    | no      | Each provider has its own ad hoc message string                  |
> | `LocalAbort`                               | yes     | `packages/agent/src/errors.ts:84` — wrong package (see Bug #1)   |
> | `effectFromSignal`                         | yes     | `packages/utils/src/effect-signal.ts` (P3a landed)               |
> | `HttpShape.request` (one-shot)             | yes     | `packages/ai/src/layers/http.ts:23`                              |
> | three providers consume `iterateWithIdleTimeout` | yes | direct calls, not via Http                                     |
> | codex `wrapCodexSseStream` / `requestSetup`| yes     | `openai-codex-responses.ts:398-411` matches brief                |
> | `packages/ai/test/abort-effect.test.ts`    | no      | Test file the brief assumed                                      |

---

## 0. Three architecture bugs in the existing three-provider design

These motivate the consolidation; the plan calls them out so the reviewer
sees the design wins, not just the surgery.

### Bug 1 — `LocalAbort` lives in the wrong package

`LocalAbort` is defined in [packages/agent/src/errors.ts:84](file:///Users/martinfan/gosh-my-pi/packages/agent/src/errors.ts#L84),
but the only sites that should ever raise it are inside `@oh-my-pi/pi-ai`
(the streaming providers and, after P4d, `Http.requestStream`). Today
`pi-agent` already depends on `pi-ai`; making `pi-ai` import `LocalAbort`
from `pi-agent` would create a cycle. The current placement effectively
prevents ADR-0004's typed-error story from being implemented as written —
the ai package has no symbol it can `Effect.fail` with.

**Fix in P4d:** move `LocalAbort` (the class, the type, and the union
membership) to `packages/ai/src/errors.ts` (new file) and re-export from
`packages/agent/src/errors.ts` so the agent runtime's `AgentTaggedError`
union and `errorToKind` switch (`packages/agent/src/error-kind.ts:87`)
keep working unchanged.

### Bug 2 — `wasCallerAbort` has a same-tick race

`createAbortSourceTracker` (`packages/ai/src/utils/abort.ts:12-36`) merges
the caller signal with a local `AbortController` via `AbortSignal.any`.
The disambiguation function:

```ts
wasCallerAbort() {
    if (callerSignal?.aborted !== true) return false;
    return requestSignal.reason !== localAbortReason;
}
```

depends on `requestSignal.reason` identity. If the watchdog fires
**and** the caller aborts within the same microtask window, `AbortSignal.any`
picks whichever underlying signal aborted first by reference, but the
listener order on the merged signal is not guaranteed to match the
local-abort-first invariant the providers assume. The result: a stalled
stream that the user happens to cancel a moment later is reported as
`stopReason: "aborted"` instead of `stopReason: "error"` with a typed
"timeout" reason. The UI then says "you cancelled" when the actual root
cause was a stuck upstream — hiding a real reliability problem.

**Fix in P4d:** kill the merged signal entirely. `Http.requestStream` owns
the fetch's `AbortController` and races three Effects (`effectFromSignal`,
watchdog, fetch). The first-aborter-wins distinction is then a direct
property of `Effect.race` rather than reasoning about signal-listener
order. Caller abort surfaces as fiber interrupt; watchdog wins surface as
`Effect.fail(LocalAbort)`. There is no "merged signal" anyone has to
introspect after the fact.

### Bug 3 — codex has no first-event timeout

[openai-responses.ts:156-167](file:///Users/martinfan/gosh-my-pi/packages/ai/src/providers/openai-responses.ts#L156-L167)
and [openai-completions.ts:286-288, 508](file:///Users/martinfan/gosh-my-pi/packages/ai/src/providers/openai-completions.ts#L286-L288)
both create a `firstEventWatchdog` via
`createWatchdog(getStreamFirstEventTimeoutMs(idleTimeoutMs), ...)` and pass
it to `iterateWithIdleTimeout` so the request is aborted if the first SSE
event takes longer than `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` (default 100 s).

[openai-codex-responses.ts:403-411](file:///Users/martinfan/gosh-my-pi/packages/ai/src/providers/openai-codex-responses.ts#L403-L411)
**does not**:

```ts
iterateWithIdleTimeout(source, {
    idleTimeoutMs: getOpenAIStreamIdleTimeoutMs(),
    errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
    onIdle: () => requestAbortController.abort(),
});
```

No `watchdog`, no `firstItemTimeoutMs`. A codex turn whose upstream never
sends the first SSE byte will hang for the full `idleTimeoutMs` (default
120 s) only after the iterator starts — and `iterateWithIdleTimeout`'s
own first-item logic (`firstItemTimeoutMs ?? idleTimeoutMs`, idle-iterator.ts:75)
falls back to the steady-state idle. Worse: the stalled handshake (TLS,
DNS, websocket-fallback path that opens but never produces a frame) has
no upper bound at all because it happens **before** the iterator is
constructed — the await on `openCodexSseEventStream` (line 632) just
sits there.

**Fix in P4d:** `Http.requestStream` always installs a first-event
watchdog. Codex inherits the same default behaviour as the other two
providers without any opt-in. P4e/P4f will spread the same fix to
responses/completions; P4d already pays the design cost.

A minor structural tail of the same bug: codex creates its
`requestAbortController` only to drive the `onIdle` rescue path
(line 409). After P4d, the fetch's controller and the codex non-fetch
controller are deliberately separate (Decision #4), so this conflation
goes away.

---

## 1. Cutover order — commit-by-commit grouping inside the single PR

Branch: `claude/p4d-http-stream-watchdog` stacked on
`claude/adr-0005-http-stream-watchdog`.

| # | Commit subject                                                            | Files                                                                                                  | Net effect                                                       |
| - | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1 | `docs(adr): add 0005 http-stream-watchdog lift`                           | `docs/adr/0005-http-stream-watchdog-lift.md` (new)                                                     | ADR text only; no code changes                                   |
| 2 | `feat(ai): move LocalAbort into pi-ai/errors`                             | `packages/ai/src/errors.ts` (new), `packages/ai/src/index.ts`, `packages/agent/src/errors.ts`          | Bug #1 fix; pi-agent re-exports for the AgentTaggedError union   |
| 3 | `feat(ai): add runWithLocalAbortWatchdog helper`                          | `packages/ai/src/utils/abort-effect.ts` (new), `packages/ai/test/abort-effect.test.ts` (new)           | Helper + unit tests; nothing consumes it yet                     |
| 4 | `feat(ai): add Http.requestStream backed by abort-effect`                 | `packages/ai/src/layers/http.ts`, `packages/ai/test/http-stream.test.ts` (new)                         | HttpShape extended; LiveHttp + makeHttpLayer construct both methods |
| 5 | `refactor(ai): migrate openai-codex-responses to Http.requestStream`      | `packages/ai/src/providers/openai-codex-responses.ts`, `packages/ai/test/openai-codex-stream.test.ts`  | Codex consumes `Http.requestStream`; non-fetch ops keep their own controller |
| 6 | `chore(ai): export Http from package surface for codex injection`         | `packages/ai/src/index.ts` (if not already exported)                                                   | Tiny, may fold into commit 4                                     |

Out of scope for P4d (do not touch in this PR):

- `openai-responses.ts`, `openai-completions.ts` — P4e
- Deletion of `runWithLocalAbortWatchdog` / `createAbortSourceTracker` — P4f
- Changes to `iterateWithIdleTimeout` itself beyond what commit 3 needs

The helper and its public export survive P4d so that during P4e the other
two providers can adopt it incrementally; P4f is the final
delete-tracker-and-helper-collapse pass.

---

## 2. ADR-0005 contents (commit 1)

File: `docs/adr/0005-http-stream-watchdog-lift.md`. Mirrors the structure
of ADR-0004. Key paragraphs:

- **Status:** Proposed 2026-05-11; finalised when P4f deletes the
  per-provider tracker plumbing.
- **Context:** ADR-0004 settled the *taxonomy* (`LocalAbort` plus
  `Effect.race`) but left the watchdog wiring duplicated across three
  providers; Bug #3 above is the proof. The Http Layer is the only
  place that already owns the fetch boundary, so it is the natural home
  for the abort+watchdog Effect race.
- **Decision:** Add `Http.requestStream` whose body callback receives a
  per-call `AbortSignal` owned by the Layer. The Layer wraps the
  resulting `AsyncIterable<T>` so the first-event watchdog and the
  steady-state idle watchdog both live inside the iterable's `next()`,
  and a caller `AbortSignal` is bridged via `effectFromSignal`.
- **Considered:** (a) leave wiring per-provider; (b) put the watchdog in
  the iterable wrapper but leave the fetch outside Http; (c) push the
  watchdog into `iterateWithIdleTimeout` itself. Rejected for
  reasons paralleling ADR-0004 — (a) duplicates Bug #3 forever, (b)
  fragments AbortController ownership, (c) couples a streaming utility
  to Effect that does not need to know.
- **Consequences:** `Http.requestStream` becomes the canonical streaming
  entrypoint; `iterateWithIdleTimeout` stays as a low-level helper used
  internally by the Layer; `runWithLocalAbortWatchdog` exists as the
  public Effect helper that providers can call directly during the
  P4d–P4f migration window.

---

## 3. `LocalAbort` move (commit 2)

`packages/ai/src/errors.ts` (new):

```ts
import { Data } from "@oh-my-pi/pi-utils/effect";

/**
 * Provider-local abort: the request was cancelled by the transport layer
 * (first-event watchdog, idle timeout, handshake stall) — *not* by the
 * caller. Caller-initiated cancellation surfaces as Effect's interrupt
 * channel and never reaches this tag.
 */
export class LocalAbort extends Data.TaggedError("LocalAbort")<{
    readonly kind: "timeout" | "idle" | "stall";
    readonly durationMs: number;
}> {}
```

`packages/ai/src/index.ts` adds `export * from "./errors"` (per repo rule:
star re-exports in barrels).

`packages/agent/src/errors.ts` becomes:

```ts
// Re-export so AgentTaggedError keeps a single import surface.
export { LocalAbort } from "@oh-my-pi/pi-ai";
```

The existing `AgentTaggedError` union (line 103) stays unchanged — the
re-exported class is identity-equal because TS types are structural and
the Data.TaggedError class is the same constructor.

`packages/agent/src/error-kind.ts:87` (`case "LocalAbort":`) needs no
changes — the tag string is the discriminant.

Verification for this commit alone:

```bash
bun --cwd=packages/ai check
bun --cwd=packages/agent check
bun --cwd=packages/agent test
```

Risk: if any external consumer outside the workspace imports `LocalAbort`
from `@oh-my-pi/pi-agent`, the re-export keeps them working.

---

## 4. `runWithLocalAbortWatchdog` helper (commit 3)

File: `packages/ai/src/utils/abort-effect.ts`. Public so P4e providers
can adopt it before P4f collapses everything into `Http.requestStream`.

```ts
import { Duration, Effect } from "@oh-my-pi/pi-utils/effect";
import { effectFromSignal } from "@oh-my-pi/pi-utils";
import { LocalAbort } from "../errors";

export interface LocalAbortWatchdogOpts {
    /** Caller-supplied signal; when it fires the program is interrupted. */
    callerSignal?: AbortSignal;
    /**
     * Idle/first-event/handshake budget. `kind` selects which LocalAbort
     * variant is raised when the budget elapses without progress.
     */
    watchdog: { kind: "timeout" | "idle" | "stall"; timeoutMs: number };
    /**
     * The actual work. Receives a per-call AbortSignal owned by this
     * helper; the body MUST thread it into whatever fetch / SSE / WS API
     * it drives so a watchdog hit also tears down the underlying I/O.
     */
    body: (signal: AbortSignal) => Promise<void>;
}

/**
 * Run `body` under a local-abort watchdog. The returned Effect:
 *  - succeeds with `void` when `body` resolves;
 *  - fails with `LocalAbort({kind, durationMs: timeoutMs})` if the
 *    watchdog elapses first;
 *  - is interrupted (no failure) if `callerSignal` aborts first.
 *
 * The per-call AbortController is always aborted in the scope finalizer,
 * so the underlying fetch sees `signal.aborted` regardless of which path
 * wins the race.
 */
export const runWithLocalAbortWatchdog = (
    opts: LocalAbortWatchdogOpts,
): Effect.Effect<void, LocalAbort> =>
    Effect.scoped(
        Effect.gen(function* () {
            const controller = new AbortController();
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => controller.abort()),
            );

            const work = Effect.tryPromise({
                try: () => opts.body(controller.signal),
                catch: cause => cause,
            }).pipe(Effect.catchAll(() => Effect.void));
            //       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
            // Body errors are surfaced through the body itself
            // (it owns its own iterator); the helper only owns the
            // race outcome.

            const watchdog = Effect.fail(
                new LocalAbort({
                    kind: opts.watchdog.kind,
                    durationMs: opts.watchdog.timeoutMs,
                }),
            ).pipe(Effect.delay(Duration.millis(opts.watchdog.timeoutMs)));

            const program = Effect.raceFirst(work, watchdog);

            if (opts.callerSignal === undefined) {
                return yield* program;
            }
            return yield* effectFromSignal(opts.callerSignal, program);
        }),
    );
```

Notes:

- `Effect.raceFirst` (not `Effect.race`) — `raceFirst` returns the first
  *exit*, which is what we want: a watchdog failure must short-circuit
  even if the body is mid-await.
- The scope finalizer aborts the controller unconditionally. On the
  happy path this is a no-op (the body has resolved and the controller
  has nothing to do); on watchdog or interrupt paths it tears down the
  fetch.
- The helper does not own the iterable — see Decision #1 below for why.

Tests live in `packages/ai/test/abort-effect.test.ts` (new file). They
cover:

| Contract                                                       | How                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Watchdog fires → `LocalAbort({kind:"timeout", durationMs})`    | Body is `() => new Promise(() => {})`, watchdog timeout 5 ms       |
| Watchdog fires → controller.signal.aborted is true             | Body captures the signal, asserts `aborted` after the failure     |
| Caller abort → fiber interrupt, body controller also aborts    | Caller signal aborts after 5 ms; assert Effect exit is interrupt  |
| Clean body → Effect succeeds, controller stays unaborted       | Body resolves immediately; assert `signal.aborted === false`      |
| Watchdog timer is cleared on success (no leak)                 | Use `vi.useFakeTimers()` and assert no pending timers after exit  |

`mock.module` is forbidden (repo rule) — these tests use `vi.spyOn` on
`Bun.sleep` only inside individual tests, with `vi.restoreAllMocks()` in
`afterEach`. No global mutation.

---

## 5. `HttpShape.requestStream` (commit 4)

### 5.1 Final shape

```ts
// packages/ai/src/layers/http.ts (additive)

import type { LocalAbort } from "../errors";

export interface HttpStreamOpts<T> {
    /** Caller's external abort signal (e.g. agent turn cancellation). */
    readonly callerSignal?: AbortSignal;
    /** First-event watchdog; `undefined` disables. */
    readonly firstEventWatchdog?: { kind: "timeout" | "idle" | "stall"; timeoutMs: number };
    /** Steady-state idle gap watchdog applied to the returned iterable. */
    readonly idleTimeoutMs?: number;
    /**
     * Open the upstream stream. The supplied `signal` is owned by the
     * Http Layer and is aborted when *any* of {watchdog, callerSignal,
     * scope close} fires. The body MUST thread the signal into its
     * fetch / WS / SSE call.
     */
    readonly body: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
    /**
     * Human-readable label for error messages (e.g.
     * `"OpenAI Codex SSE stream"`); keeps watchdog errors discoverable
     * in logs without leaking provider strings into the helper.
     */
    readonly label: string;
}

export interface HttpShape {
    readonly request: (
        input: RequestInfo,
        init?: RequestInit,
    ) => Effect.Effect<Response, HttpError>;

    /**
     * Open a streamed response under a per-call AbortController and
     * watchdog. Yields an AsyncIterable that the caller iterates with
     * `for await`; iteration itself enforces the idle watchdog and can
     * reject with `LocalAbort({kind:"idle", ...})`.
     *
     * The Effect part of the return value resolves once the stream
     * *opens* (body promise has produced the iterable). This split
     * lets the caller race iteration against unrelated Effects without
     * trapping them in a long-lived Effect scope.
     */
    readonly requestStream: <T>(
        opts: HttpStreamOpts<T>,
    ) => Effect.Effect<AsyncIterable<T>, LocalAbort>;
}
```

### 5.2 LiveHttp implementation skeleton

```ts
import { iterateWithIdleTimeout } from "../utils/idle-iterator";
import { runWithLocalAbortWatchdog } from "../utils/abort-effect";
import { LocalAbort } from "../errors";

function buildStreamer(): HttpShape["requestStream"] {
    return <T>(opts: HttpStreamOpts<T>) =>
        Effect.scoped(
            Effect.gen(function* () {
                const controller = new AbortController();
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => controller.abort()),
                );

                // Bridge caller signal -> controller (no merged signal,
                // see Bug #2 fix).
                if (opts.callerSignal !== undefined) {
                    if (opts.callerSignal.aborted) {
                        controller.abort();
                    } else {
                        const onAbort = () => controller.abort();
                        opts.callerSignal.addEventListener("abort", onAbort, {
                            once: true,
                        });
                        yield* Effect.addFinalizer(() =>
                            Effect.sync(() =>
                                opts.callerSignal?.removeEventListener(
                                    "abort",
                                    onAbort,
                                ),
                            ),
                        );
                    }
                }

                // Race the open-promise with the first-event watchdog.
                // `body` returns the *iterable*; the watchdog fires if
                // the body promise hasn't resolved within the budget.
                const open = Effect.tryPromise({
                    try: () => opts.body(controller.signal),
                    catch: cause => cause,
                });

                const iterable = yield* (opts.firstEventWatchdog === undefined
                    ? open.pipe(
                          Effect.catchAll(cause =>
                              Effect.fail(
                                  new LocalAbort({
                                      kind: "stall",
                                      durationMs: 0,
                                  }) as LocalAbort,
                              ),
                          ),
                      )
                    : Effect.raceFirst(
                          open.pipe(
                              Effect.catchAll(cause =>
                                  // Treat fetch failure as `stall` (handshake
                                  // never produced a response).
                                  Effect.fail(
                                      new LocalAbort({
                                          kind: "stall",
                                          durationMs: 0,
                                      }),
                                  ),
                              ),
                          ),
                          Effect.fail(
                              new LocalAbort({
                                  kind: opts.firstEventWatchdog.kind,
                                  durationMs:
                                      opts.firstEventWatchdog.timeoutMs,
                              }),
                          ).pipe(
                              Effect.delay(
                                  Duration.millis(
                                      opts.firstEventWatchdog.timeoutMs,
                                  ),
                              ),
                          ),
                      )) as AsyncIterable<T>;

                // Wrap with the idle-timeout iterator. The wrapper aborts
                // the controller on idle, which kills the underlying fetch.
                if (
                    opts.idleTimeoutMs === undefined ||
                    opts.idleTimeoutMs <= 0
                ) {
                    return iterable;
                }
                return iterateWithIdleTimeout(iterable, {
                    idleTimeoutMs: opts.idleTimeoutMs,
                    errorMessage: `${opts.label} stalled while waiting for the next event`,
                    onIdle: () => controller.abort(),
                });
            }),
        );
}

export const LiveHttp: Layer.Layer<Http> = Layer.succeed(Http)({
    request: buildRequester(fetch),
    requestStream: buildStreamer(),
});

export function makeHttpLayer(fetchFn: typeof fetch): Layer.Layer<Http> {
    return Layer.succeed(Http)({
        request: buildRequester(fetchFn),
        requestStream: buildStreamer(),
    });
}
```

Two non-obvious design points called out so the reviewer doesn't have to
re-derive them:

- **`makeHttpLayer(fetchFn)` does NOT thread `fetchFn` into `requestStream`.**
  The body callback already owns its fetch invocation (codex calls
  `fetchWithRetry`, openai SDK uses its own internal client). The test
  seam for `requestStream` is the body callback itself, not a stub
  `fetchFn`. If a future test needs to swap the fetch underneath the
  body, it does so by replacing the body — there is no value in adding
  a second indirection.
- **`Effect.raceFirst` not `Effect.race`** — same reason as the helper:
  watchdog must short-circuit even if the body is mid-await.

### 5.3 Tests for commit 4

`packages/ai/test/http-stream.test.ts` (new). Each contract:

| Test                                                              | Assertion                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Watchdog fires before body resolves → `LocalAbort.kind="timeout"` | Effect exit is `Failure(LocalAbort)`; body's signal is aborted                    |
| Caller signal fires before body resolves → fiber interrupt        | Exit `_tag` is `"Failure"` with `Cause.isInterrupted`; body's signal is aborted   |
| Body resolves cleanly → returns iterable; signal not aborted      | `controller.signal.aborted === false` at scope exit                               |
| Iterating returned iterable past `idleTimeoutMs` → throws         | `iterator.next()` rejects with the `${label} stalled ...` Error; signal aborted   |
| Iterating cleanly → all yielded values flow                       | Async generator that yields `[1,2,3]` produces `[1,2,3]` in caller                |

Mock strategy: each test constructs its own body callback (no module
mocks). Iterables are hand-rolled `async function*` with `Bun.sleep`
gaps. Tests run with the default `vi` clock; do not use `vi.useFakeTimers()`
across files (full-suite-safety rule). For the watchdog tests use a 10 ms
budget and a body that awaits a 1 s sleep — the actual real time the
suite spends is ~10 ms per test.

---

## 6. Codex migration — per-line change summary (commit 5)

File: `packages/ai/src/providers/openai-codex-responses.ts`. Every line
range touched, with before/after.

### 6.1 Imports (lines 42, plus a new one)

**Before** (line 42):
```ts
import { getOpenAIStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
```

**After:**
```ts
import { getOpenAIStreamIdleTimeoutMs, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { Http, makeHttpLayer } from "../layers/http"; // service tag for injection
import { Effect, Layer, ManagedRuntime } from "@oh-my-pi/pi-utils/effect";
```

`iterateWithIdleTimeout` is no longer imported by codex — `Http.requestStream`
handles it.

### 6.2 `CodexRequestSetup` (lines 136-140) — shrink

**Before:**
```ts
interface CodexRequestSetup {
    requestSignal: AbortSignal;
    wrapCodexSseStream: (source: AsyncGenerator<...>) => AsyncGenerator<...>;
    requestAbortController: AbortController;
}
```

**After:**
```ts
interface CodexRequestSetup {
    /** Owns *non-fetch* aborts only: retry sleeps, websocket reconnects,
     *  follow-up turns. Fetch lifetime is owned by Http.requestStream. */
    nonFetchAbortController: AbortController;
    nonFetchSignal: AbortSignal;
    /** Caller signal, kept so we can pass it to Http.requestStream and to
     *  abortableSleep for non-fetch ops. */
    callerSignal: AbortSignal | undefined;
}
```

Renamed `requestAbortController` → `nonFetchAbortController` and
`requestSignal` → `nonFetchSignal` so the next reviewer doesn't have to
re-read the type to know which controller they're touching. `wrapCodexSseStream`
is gone.

### 6.3 `createRequestSetup` (lines 398-412) — collapse

**Before:**
```ts
function createRequestSetup(options): CodexRequestSetup {
    const requestAbortController = new AbortController();
    const requestSignal = options?.signal
        ? AbortSignal.any([options.signal, requestAbortController.signal])
        : requestAbortController.signal;
    const wrapCodexSseStream = (source) => iterateWithIdleTimeout(source, {
        idleTimeoutMs: getOpenAIStreamIdleTimeoutMs(),
        errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
        onIdle: () => requestAbortController.abort(),
    });
    return { requestAbortController, requestSignal, wrapCodexSseStream };
}
```

**After:**
```ts
function createRequestSetup(options): CodexRequestSetup {
    const nonFetchAbortController = new AbortController();
    // Bridge caller -> non-fetch controller so a caller abort *also*
    // cancels any in-flight retry sleep / websocket reconnect.
    if (options?.signal) {
        if (options.signal.aborted) nonFetchAbortController.abort();
        else options.signal.addEventListener(
            "abort",
            () => nonFetchAbortController.abort(),
            { once: true },
        );
    }
    return {
        nonFetchAbortController,
        nonFetchSignal: nonFetchAbortController.signal,
        callerSignal: options?.signal,
    };
}
```

The `AbortSignal.any` merge is deleted (Bug #2 fix). The watchdog
collapsing is delegated to `Http.requestStream`.

### 6.4 `openCodexSseTransport` (lines 620-644) — call into Http

**Before:**
```ts
const eventStream = requestSetup.wrapCodexSseStream(
    await openCodexSseEventStream(
        requestContext.url,
        requestContext.requestHeaders,
        requestContext.accountId,
        requestContext.apiKey,
        options?.sessionId,
        body,
        state,
        requestSetup.requestSignal,
    ),
);
return { eventStream, requestBodyForState: structuredCloneJSON(body), transport: "sse" };
```

**After:**
```ts
// Http is provided via Effect runtime in streamOpenAICodexResponses (6.7).
const eventStream = await Effect.runPromise(
    Http.pipe(
        Effect.flatMap(http =>
            http.requestStream<Record<string, unknown>>({
                callerSignal: requestSetup.callerSignal,
                firstEventWatchdog: {
                    kind: "timeout",
                    timeoutMs:
                        options?.streamFirstEventTimeoutMs ??
                        getStreamFirstEventTimeoutMs(getOpenAIStreamIdleTimeoutMs()) ??
                        100_000,
                },
                idleTimeoutMs: getOpenAIStreamIdleTimeoutMs(),
                label: "OpenAI Codex SSE stream",
                body: signal =>
                    openCodexSseEventStream(
                        requestContext.url,
                        requestContext.requestHeaders,
                        requestContext.accountId,
                        requestContext.apiKey,
                        options?.sessionId,
                        body,
                        state,
                        signal, // <-- Http-owned, replaces requestSetup.requestSignal
                    ),
            }),
        ),
        Effect.provide(requestContext.httpLayer),
    ),
);
return { eventStream, requestBodyForState: structuredCloneJSON(body), transport: "sse" };
```

Note `requestContext.httpLayer` — see 6.5.

### 6.5 `buildCodexRequestContext` (line 414) — pipe Http through

Add one field to `CodexRequestContext` (line 124):

```ts
interface CodexRequestContext {
    // ...existing fields...
    httpLayer: Layer.Layer<Http>;
}
```

And one line in `buildCodexRequestContext`'s return value (around line
460):

```ts
return {
    apiKey,
    accountId,
    baseUrl,
    url,
    requestHeaders,
    providerSessionState,
    websocketState,
    transformedBody,
    rawRequestDump,
    httpLayer: options?.httpLayer ?? LiveHttp,
};
```

This mirrors the existing `fetchFn` test seam in
`fetchCodexModels` (`packages/ai/src/layers/http.ts:42-46`): a
test-only `OpenAICodexResponsesOptions.httpLayer?: Layer.Layer<Http>`
field lets `openai-codex-stream.test.ts` inject a stub that yields a
hand-rolled iterable, without `mock.module` or global fetch
substitution.

### 6.6 Websocket path (lines 610-617) — leave alone

`openCodexWebSocketTransport` does not flow through `Http.requestStream`
in P4d. Justification:

- The websocket call (`openCodexWebSocketEventStream` line 1994) already
  owns its own retry / reconnect lifecycle and does not perform an HTTP
  request — `Http.requestStream` would not match its semantics without
  generalising the helper to "open any cancellable async iterable",
  which is scope creep.
- The websocket fallback path (codex falls back to SSE on failure, line
  576) means the watchdog wins still get applied via the SSE path on
  retry.
- ADR-0005 explicitly notes that `requestStream` is the *HTTP* streaming
  consolidation; websocket consolidation is a candidate follow-up but
  not part of this lift.

`requestSetup.requestSignal` at line 615 becomes
`requestSetup.nonFetchSignal` (it's a websocket open, not an HTTP fetch).

### 6.7 `streamOpenAICodexResponses` entrypoint (line 1380) — provide Http runtime

**Before** (relevant slice, lines 1387-1395):
```ts
void (async () => {
    const startTime = Date.now();
    const output = createAssistantOutput(model);
    const requestSetup = createRequestSetup(options);
    let processingContext: CodexStreamProcessingContext | undefined;

    try {
        const requestContext = await buildCodexRequestContext(model, context, options, output);
        const initialTransport = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
```

**After:**
```ts
void (async () => {
    const startTime = Date.now();
    const output = createAssistantOutput(model);
    const requestSetup = createRequestSetup(options);
    let processingContext: CodexStreamProcessingContext | undefined;

    try {
        const requestContext = await buildCodexRequestContext(model, context, options, output);
        // Build a ManagedRuntime once per turn so all six possible
        // openCodexSseTransport calls (initial + reopens + provider
        // retries) share the same Http instance and finalizer scope.
        const runtime = ManagedRuntime.make(requestContext.httpLayer);
        try {
            const initialTransport = await openInitialCodexEventStream(
                model,
                options,
                requestSetup,
                requestContext,
                runtime, // <-- thread runtime
            );
            // ...rest unchanged...
        } finally {
            await runtime.dispose();
        }
```

`openInitialCodexEventStream`, `openCodexSseTransport`, and
`reopenCodexSseRuntimeStream` (lines 678) all gain a `runtime:
ManagedRuntime.ManagedRuntime<Http, never>` parameter and use
`runtime.runPromise(...)` instead of `Effect.runPromise(...)`. This is
mechanical.

### 6.8 `requestSignal` consumers — explicit table

Every call site of `requestSetup.requestSignal` from the brief:

| Line  | Site                                                              | After P4d                                                                            |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 569   | `abortableSleep(...)` for websocket retry delay                   | `requestSetup.nonFetchSignal` — caller-abort still tears down the sleep              |
| 615   | `openCodexWebSocketEventStream(..., requestSetup.requestSignal)`  | `requestSetup.nonFetchSignal` — websocket open is not Http (see 6.6)                 |
| 640   | `openCodexSseEventStream(..., requestSetup.requestSignal)`        | **Replaced** by the Http-owned `signal` from the body callback (see 6.4)             |
| 1263  | `abortableSleep(...)` for websocket-stream retry delay            | `requestSetup.nonFetchSignal`                                                        |
| 1315  | `abortableSleep(...)` for provider retry delay                    | `requestSetup.nonFetchSignal`                                                        |

Result: 4 of 5 sites use the renamed non-fetch signal; only the SSE open
itself flows through the Http-owned signal. This matches Decision #4 —
the two controllers are sibling concerns, not overlapping.

### 6.9 Catch / error path (lines 1326-1378) — minimal change

The existing `finalizeCodexResponse` and `handleCodexStreamFailure`
already key on `context.options?.signal?.aborted` to distinguish
caller-abort from error. After P4d:

- A watchdog hit raises `LocalAbort`, which propagates out of
  `Effect.runPromise` as a rejected promise wrapping the tagged error.
- `handleCodexStreamFailure` adds one branch:
  ```ts
  if (error instanceof LocalAbort) {
      output.stopReason = "error";
      output.errorMessage = `Codex stream ${error.kind} after ${error.durationMs}ms`;
      // ...timing fields...
      return output;
  }
  ```
- Caller-abort detection at line 1332 stays — it inspects the
  `options.signal`, which is unaffected.

### 6.10 What stays exactly the same

- Websocket session state machine (lines 100-410, except imports).
- All header construction and request body shape.
- The streaming event processor itself (`processCodexResponseStream`,
  not shown in this plan — uses `for await` over `runtime.eventStream`,
  which is now an iterable supplied by `Http.requestStream`).
- All retry / fallback policy.
- The `prewarmOpenAICodexResponses` function (line 1455) — uses
  `getOrCreateCodexWebSocketConnection` directly, not the SSE path.

---

## 7. Test plan

### 7.1 New test files

- `packages/ai/test/abort-effect.test.ts` — see §4. Covers the helper.
- `packages/ai/test/http-stream.test.ts` — see §5.3. Covers
  `Http.requestStream`.

### 7.2 Updated existing tests

- `packages/ai/test/openai-codex-stream.test.ts` — add cases:
    1. Codex stream with first-event watchdog of 5 ms → assistant
       message has `stopReason: "error"`, `errorMessage` contains
       `"timeout"` and `"5ms"` (or duration).
    2. Codex stream with steady-state idle watchdog of 5 ms triggered
       mid-stream → `stopReason: "error"`, `errorMessage` contains
       `"stalled while waiting for the next event"`.
    3. Caller abort mid-stream → `stopReason: "aborted"`.
    4. Happy-path stream → no behavioural change vs. pre-P4d golden.

  Use the new `OpenAICodexResponsesOptions.httpLayer` injection seam
  (§6.5). The stub layer's `requestStream` returns hand-rolled
  iterables that yield with chosen delays. The stub `request` can
  remain `LiveHttp.request` — codex doesn't use it.

### 7.3 Tests we explicitly do NOT add or change

- Tests for `iterateWithIdleTimeout` directly — out of scope; the helper
  is unchanged.
- Tests for `openai-responses.ts` / `openai-completions.ts` watchdog
  semantics — those wait for P4e.
- A "delete `createAbortSourceTracker`" test — it stays in P4d.

### 7.4 Test hygiene (repo rule reminder)

- No `mock.module`. Use `vi.spyOn` on imported module objects, restore in
  `afterEach`.
- No global mutation of `Bun.*` / `process.env` outside a test that
  immediately restores it.
- All new tests must pass when the file runs alone *and* when the entire
  package suite runs.

---

## 8. Decisions — answers to the brief's nine open questions

1. **`requestStream` signature (caller iterates).** Returns
   `Effect.Effect<AsyncIterable<T>, LocalAbort>`. The Effect resolves
   when the stream *opens*; the caller does the `for await`. The idle
   watchdog is baked into the returned iterable's `next()` (via
   `iterateWithIdleTimeout`), so the watchdog stays live during external
   iteration without forcing the caller to keep an Effect scope open
   for the entire stream lifetime. Per-call AbortController abort fires
   in the scope finalizer, so caller-side iteration that ends naturally
   (or throws) tears down the fetch.

2. **What `wrapCodexSseStream(source)` becomes.** Codex no longer calls
   any wrapping function — `Http.requestStream` returns the already-wrapped
   iterable. `openCodexSseTransport` (line 631) becomes a single
   `await Effect.runPromise(Http.requestStream(...))` call, see §6.4.

3. **Codex `requestSignal` survival.** The existing signal is renamed to
   `nonFetchSignal` and survives for retry sleeps + websocket open.
   Only the SSE open call site (line 640) is rewired to use the
   Http-owned signal. Table in §6.8.

4. **Per-call AbortController ownership.** Confirmed: two controllers,
   non-overlapping. `AbortSignal.any` merge is deleted (Bug #2 fix).
   The non-fetch controller listens to caller-abort so retry sleeps and
   websocket opens are still cancellable from the caller side.

5. **Idle-watchdog placement.** Inside `Http.requestStream`'s iterable
   wrapper (option (a) in the brief). Consolidates Bug #3 across all
   three providers in P4e/P4f for free, keeps the iterable's iteration
   contract aware of its own watchdog, and removes the iterator-vs-fetch
   ownership question entirely.

6. **Test surface.** Two new files: `http-stream.test.ts` for the
   contract, `abort-effect.test.ts` for the helper. The existing
   `openai-codex-stream.test.ts` is updated with watchdog scenarios
   using the new `httpLayer` injection seam. `createAbortSourceTracker`
   tests (if any — there are none today) stay alone.

7. **Codex line ranges.** §6 spells them out; recap: 42 (imports),
   124-134 (CodexRequestContext +httpLayer), 136-140 (CodexRequestSetup
   shrink), 398-412 (createRequestSetup collapse), 460 (return
   includes httpLayer), 569 / 1263 / 1315 (rename to nonFetchSignal),
   615 (rename to nonFetchSignal), 631-642 (Http.requestStream call),
   1326-1378 (catch branch for LocalAbort), 1387-1395 (ManagedRuntime
   construction in entrypoint).

8. **Http Layer construction.** `LiveHttp` and `makeHttpLayer` both
   build `{ request, requestStream }`. `makeHttpLayer(fetchFn)` does
   *not* propagate `fetchFn` to the streaming method (see §5.2 second
   bullet) — the streaming test seam is the body callback the caller
   provides, not the fetch underneath.

9. **Out-of-scope confirmation.** Confirmed: P4d touches only
   `openai-codex-responses.ts` among providers. `openai-responses.ts`,
   `openai-completions.ts`, and the deletion of
   `createAbortSourceTracker` / `runWithLocalAbortWatchdog` all stay
   for P4e/P4f. The helper is exported during P4d so P4e providers can
   adopt it incrementally.

---

## 9. Risks / unknowns

- **`ManagedRuntime` lifetime under retry storms.** Codex's
  `processCodexResponseStream` can call `reopenCodexSseRuntimeStream`
  multiple times per turn (websocket fallback + provider retries). The
  per-turn ManagedRuntime in §6.7 is the right granularity, but if a
  reopen happens after the runtime has been disposed (because the
  caller cancelled the outer `for await`), `runtime.runPromise` will
  throw a synchronous "runtime disposed" error. Need to confirm the
  catch in `handleCodexStreamFailure` treats that as
  `stopReason: "aborted"`, not `"error"`. **Action:** add a regression
  test for "caller aborts during reopen window".
- **`Effect.raceFirst` semantics in pi-utils' Effect re-export.** The
  workspace re-exports a curated subset from
  `@oh-my-pi/pi-utils/effect`. Verify `raceFirst` and
  `ManagedRuntime` are re-exported; if not, add to that surface in
  commit 3 (a one-line change).
- **`fetchWithRetry`'s own internal abort handling.** The codex SSE
  open (line 1964) goes through `fetchWithRetry`, which may swallow
  `signal.aborted` and surface a generic error rather than propagating
  the abort. If so, the Http watchdog will still fire correctly but
  the body-rejected-then-watchdog-rejected race may produce a
  duplicate failure. Investigation required during commit 5: read
  `fetchWithRetry` and decide whether to bypass it for the
  `Http.requestStream` path.
- **Bug #1 fix and external consumers.** The re-export from
  `pi-agent` keeps `import { LocalAbort } from "@oh-my-pi/pi-agent"`
  working, but any third-party that does
  `instanceof Data.TaggedError("LocalAbort")` against the agent's
  copy will still match — TaggedError discriminates on `_tag`, not
  identity. Low risk.

---

## 10. Verification plan

Run after each commit, and one final pass at the tip of the branch:

```bash
# Per-commit (after commits 2, 3, 4, 5):
bun --cwd=packages/ai test
bun --cwd=packages/agent test     # confirms Bug #1 fix did not regress
                                  # the AgentTaggedError discriminated union
bun check:ts                       # workspace-wide format + lint + tsgo

# Tip-of-branch only:
bun --cwd=packages/coding-agent test    # smoke; expected untouched
```

Manual smoke (commit 5 only):

1. With a real codex API key:
   ```bash
   PI_STREAM_FIRST_EVENT_TIMEOUT_MS=2000 omp -m codex -p "hello"
   ```
   Expect normal completion. Then:
   ```bash
   PI_STREAM_FIRST_EVENT_TIMEOUT_MS=1 omp -m codex -p "hello"
   ```
   Expect `stopReason: "error"` with a `LocalAbort{kind:"timeout"}`-derived
   message. Pre-P4d this would have hung for 100 s.

2. Caller abort:
   ```bash
   omp -m codex -p "long answer"   # then Ctrl-C mid-stream
   ```
   Expect `stopReason: "aborted"` (not `"error"`). Confirms Bug #2 fix.

Lint constraints to verify before requesting review:

- `oxlint` clean (no `any`, no `private`/`public`/`protected` outside
  constructor parameter properties, no `ReturnType<…>`, no inline
  imports).
- All new files use namespace imports for `node:fs`/`node:path`/`node:os`.
- No `console.*` in any modified file.
- Star re-exports in any barrel touched.
- Tests do not use `mock.module`.
