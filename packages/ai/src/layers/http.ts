// Http Layer — wraps `fetch` as an Effect service so call sites can be
// provided with a real fetch (LiveHttp) or a test stub (makeHttpLayer).
//
// Scope:
//   - `request`: one-shot fetch returning an Effect<Response, HttpError>.
//     Introduced in P1 for codex model discovery. Non-2xx responses are
//     NOT raised here — callers inspect `Response.ok` themselves so retry /
//     fallback logic stays explicit.
//   - `requestStream`: streaming variant introduced in P4d (ADR-0005).
//     Wraps `runWithLocalAbortWatchdog` so all three streaming providers
//     (openai-responses, openai-completions, openai-codex-responses) share
//     one transport seam for per-call AbortController + caller-signal
//     forwarding + first-event watchdog + STREAM_STALLED_SUFFIX rewrap +
//     scope finalizer that aborts the underlying fetch on non-success exit.
//     P4e migrates the first two providers; P4f deletes the helper module
//     once it has no public callers.

import { Context, Data, Effect, Layer } from "@oh-my-pi/pi-utils/effect";
import type { LocalAbort } from "../errors";
import { runWithLocalAbortWatchdog } from "../utils/abort-effect";

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
 * Watchdog config for `HttpShape.requestStream`. Duplicates the helper's
 * shape so callers don't need to import from the helper module (which will
 * become private after P4f).
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
	 * via `iterateWithIdleTimeout` wrapped around the returned iterable).
	 * Idle throws matching `STREAM_STALLED_SUFFIX` are rewrapped to
	 * `LocalAbort({ kind: "idle" })` only if they happen INSIDE the body's
	 * Promise (i.e. before the iterable is returned); throws DURING iteration
	 * propagate to the caller's `for await` boundary unchanged.
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

function buildStreamRequester(): HttpShape["requestStream"] {
	return <T>(opts: RequestStreamOptions<T>) =>
		Effect.tryPromise({
			try: () =>
				runWithLocalAbortWatchdog<AsyncIterable<T>>({
					callerSignal: opts.callerSignal,
					firstEventWatchdog: opts.firstEventWatchdog,
					body: opts.body,
				}),
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
