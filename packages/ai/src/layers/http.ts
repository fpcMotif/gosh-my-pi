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
//
// The `runStreamProgram` helper below is the building block that drives
// `LiveHttp.requestStream`. Lifted from `packages/ai/src/utils/abort-effect.ts`
// in P4f when the helper module was deleted (it had no callers outside this
// module).

import { Context, Data, Effect, effectFromSignal, Layer } from "@oh-my-pi/pi-utils/effect";
import { LocalAbort } from "../errors";
import { STREAM_STALLED_SUFFIX } from "../utils/idle-iterator";

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
 * Watchdog config for `HttpShape.requestStream`. The watchdog fires once,
 * after `timeoutMs`, failing the Effect with `LocalAbort({ kind, durationMs })`.
 * Setting `timeoutMs <= 0` disables it.
 */
export interface FirstEventWatchdogConfig {
	readonly kind: "timeout" | "idle" | "stall";
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
	 * outside the body rewrap them in their catch boundary.
	 *
	 * Providers that consume the stream inside the body (option-A pattern,
	 * used by openai-responses + openai-completions) can return an empty
	 * iterable as a no-op sentinel; the body-time rewrap covers idle stalls
	 * via the helper itself.
	 */
	readonly body: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
}

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
 * Build the streaming runner. Wraps a Promise-returning body in an Effect
 * scope: the scope owns a per-call `AbortController`, races the body against
 * an optional first-event watchdog Effect, and aborts the controller on any
 * non-success exit. Caller signal abort interrupts the fiber via
 * `effectFromSignal`, which the scope finalizer observes.
 */
function runStreamProgram<T>(opts: RequestStreamOptions<T>): Promise<AsyncIterable<T>> {
	const { callerSignal, firstEventWatchdog, body } = opts;
	const program = Effect.scoped(
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
				catch: (cause: unknown): LocalAbort | unknown => {
					if (cause instanceof Error && cause.message.endsWith(STREAM_STALLED_SUFFIX)) {
						return new LocalAbort({ kind: "idle", durationMs: Date.now() - startedAt });
					}
					return cause;
				},
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
	return Effect.runPromise(program) as Promise<AsyncIterable<T>>;
}

function buildStreamRequester(): HttpShape["requestStream"] {
	return <T>(opts: RequestStreamOptions<T>) =>
		Effect.tryPromise({
			try: () => runStreamProgram<T>(opts),
			catch: (cause: unknown): LocalAbort | unknown => cause,
		});
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
