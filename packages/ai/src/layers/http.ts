// Http Layer — wraps `fetch` as an Effect service so call sites can be
// provided with a real fetch (LiveHttp) or a test stub (makeHttpLayer).
//
// Scope:
//   - `request`: one-shot fetch returning an Effect<Response, HttpError>.
//     Introduced in P1 for codex model discovery. Non-2xx responses are
//     NOT raised here — callers inspect `Response.ok` themselves so retry /
//     fallback logic stays explicit.
//   - `requestStream`: streaming variant introduced in P4d (ADR-0005).
//     Bundles the per-call AbortController + caller-signal forwarding +
//     first-event watchdog + STREAM_STALLED_SUFFIX rewrap + scope finalizer
//     that aborts the underlying fetch on non-success exit. All three
//     streaming providers (openai-responses, openai-completions,
//     openai-codex-responses) route through this method as of P4e.

import { Context, Data, Effect, effectFromSignal, Layer } from "@oh-my-pi/pi-utils/effect";
import { LocalAbort, rewrapStalledStream } from "../errors";

/**
 * Tagged error raised by the Http service when the underlying `fetch` rejects
 * (network error, abort, DNS, etc.). Non-2xx responses are NOT raised here —
 * callers inspect `Response.ok` themselves so retry / fallback logic stays
 * explicit.
 */
export class HttpError extends Data.TaggedError("HttpError")<{
	readonly cause: unknown;
	readonly url: string;
}> {}

/**
 * Watchdog config for `HttpShape.requestStream`. Fires once after `timeoutMs`,
 * failing the Effect with `LocalAbort({ kind: "timeout", durationMs })`.
 * Setting `timeoutMs <= 0` disables it. The `kind` field exists so future
 * watchdog variants (e.g., TLS-handshake stall detection) can reuse the same
 * config shape; today the only producer is the first-event watchdog and the
 * only kind used is `"timeout"`.
 */
export interface FirstEventWatchdogConfig {
	readonly kind: "timeout";
	readonly timeoutMs: number;
}

/** Options accepted by `HttpShape.requestStream`. */
export interface RequestStreamOptions<T> {
	readonly callerSignal?: AbortSignal;
	readonly firstEventWatchdog?: FirstEventWatchdogConfig;
	/**
	 * Caller-supplied body. The provided signal MUST be threaded into the
	 * underlying fetch / SDK call. `requestStream` owns the controller backing
	 * the signal and aborts it on watchdog fire, caller-signal fire, or body
	 * throw — releasing the response body reader.
	 *
	 * The returned `AsyncIterable<T>` is the stream the caller consumes via
	 * `for await`. First-event timing is enforced by `firstEventWatchdog`;
	 * inter-event idle stalls stay the caller's responsibility (typically
	 * via `iterateWithIdleTimeout` wrapped around the returned iterable or
	 * inside the body). Idle throws matching `STREAM_STALLED_SUFFIX` are
	 * rewrapped to `LocalAbort({ kind: "idle" })` only if they happen
	 * INSIDE the body's Promise; throws DURING iteration propagate to the
	 * caller's `for await` boundary unchanged, and providers that iterate
	 * outside the body rewrap them in their catch boundary via
	 * `rewrapStalledStream`.
	 *
	 * Option-A providers that consume the stream inside the body (e.g.,
	 * `openai-completions`) return `EMPTY_STREAM_SENTINEL` as a no-op return
	 * value; the body-time rewrap covers idle stalls via the helper itself.
	 */
	readonly body: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
}

/**
 * No-op iterable returned by option-A providers that consume the stream
 * inside the `body` callback. `http.requestStream`'s caller iterates this
 * and immediately gets `{ done: true }`.
 */
export const EMPTY_STREAM_SENTINEL: AsyncIterable<never> = {
	async *[Symbol.asyncIterator]() {},
};

/** Public shape of the Http service. */
export interface HttpShape {
	readonly request: (input: RequestInfo, init?: RequestInit) => Effect.Effect<Response, HttpError>;
	readonly requestStream: <T>(opts: RequestStreamOptions<T>) => Effect.Effect<AsyncIterable<T>, LocalAbort | unknown>;
}

/** Service tag for the Http Layer. */
export class Http extends Context.Service<Http, HttpShape>()("@oh-my-pi/pi-ai/Http") {}

function buildRequester(fetchFn: typeof fetch): HttpShape["request"] {
	return (input, init) =>
		Effect.tryPromise({
			try: signal => fetchFn(input, { ...init, signal: init?.signal ?? signal }),
			catch: cause => new HttpError({ cause, url: typeof input === "string" ? input : input.toString() }),
		});
}

/**
 * Streaming requester. Wraps `body` in an Effect scope that owns a per-call
 * `AbortController`, races the body against an optional first-event watchdog
 * Effect, and aborts the controller on any non-success exit. Caller-signal
 * abort interrupts the fiber via `effectFromSignal`, which the scope
 * finalizer observes. Body-time `STREAM_STALLED_SUFFIX` throws are rewrapped
 * as `LocalAbort({ kind: "idle" })` via the shared helper in `../errors`.
 */
function buildStreamRequester(): HttpShape["requestStream"] {
	return <T>(opts: RequestStreamOptions<T>) => {
		const { callerSignal, firstEventWatchdog, body } = opts;
		return Effect.scoped(
			Effect.gen(function* () {
				const controller = new AbortController();
				yield* Effect.addFinalizer(exit =>
					Effect.sync(() => {
						if (exit._tag !== "Success" && !controller.signal.aborted) {
							controller.abort();
						}
					}),
				);

				const startedAt = Date.now();

				const bodyEffect = Effect.tryPromise({
					try: effectSignal => {
						if (effectSignal.aborted) {
							controller.abort();
						} else {
							effectSignal.addEventListener(
								"abort",
								() => {
									if (!controller.signal.aborted) controller.abort();
								},
								{ once: true },
							);
						}
						return body(controller.signal);
					},
					catch: (cause: unknown): LocalAbort | unknown => rewrapStalledStream(cause, startedAt),
				});

				const watchdogEffect: Effect.Effect<never, LocalAbort> =
					firstEventWatchdog && firstEventWatchdog.timeoutMs > 0
						? Effect.flatMap(Effect.sleep(`${firstEventWatchdog.timeoutMs} millis`), () =>
								Effect.fail(
									new LocalAbort({
										kind: firstEventWatchdog.kind,
										durationMs: firstEventWatchdog.timeoutMs,
									}),
								),
							)
						: Effect.never;

				const raced = Effect.raceFirst(bodyEffect, watchdogEffect);
				return yield* callerSignal ? effectFromSignal(callerSignal, raced) : raced;
			}),
		);
	};
}

/** Live Layer — uses the global `fetch` and the production watchdog. */
export const LiveHttp: Layer.Layer<Http> = Layer.succeed(Http)({
	request: buildRequester(fetch),
	requestStream: buildStreamRequester(),
});

/**
 * Construct an Http Layer that delegates to a custom `fetch` implementation.
 * Used by tests + the codex models resolver's `fetchFn` option. The streaming
 * method is unaffected by `fetchFn` because its body callback owns the
 * underlying network call directly.
 */
export function makeHttpLayer(fetchFn: typeof fetch): Layer.Layer<Http> {
	return Layer.succeed(Http)({
		request: buildRequester(fetchFn),
		requestStream: buildStreamRequester(),
	});
}
