// Http Layer — wraps `fetch` as an Effect service so call sites can be
// provided with a real fetch (LiveHttp) or a test stub (makeHttpLayer).
//
// Two methods:
//   request: one-shot fetch, used today by codex model discovery.
//   requestStream: streaming open under a per-call AbortController plus
//     first-event + idle watchdogs. Yields an AsyncIterable the caller
//     iterates with `for await`. The watchdog pipeline is owned here so
//     providers stop reimplementing it (see ADR-0005).

import { Context, Data, Duration, Effect, Layer } from "@oh-my-pi/pi-utils/effect";
import { effectFromSignal } from "@oh-my-pi/pi-utils/effect-signal";
import { LocalAbort } from "../errors";
import { iterateWithIdleTimeout } from "../utils/idle-iterator";

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

export class HttpStreamBodyError extends Data.TaggedError("HttpStreamBodyError")<{
	readonly cause: unknown;
	readonly label: string;
}> {}

export function unwrapHttpStreamBodyError(error: unknown): unknown {
	return error instanceof HttpStreamBodyError ? error.cause : error;
}

export interface HttpStreamOpts<T> {
	/** Caller's external abort signal (e.g. agent turn cancellation). */
	readonly callerSignal?: AbortSignal;
	/** First-event watchdog; `undefined` disables. */
	readonly firstEventWatchdog?: { readonly kind: "timeout" | "idle" | "stall"; readonly timeoutMs: number };
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
	 * Human-readable label for idle-timeout error messages, e.g.
	 * `"OpenAI Codex SSE stream"`. Keeps the helper provider-agnostic
	 * while still producing discoverable logs.
	 */
	readonly label: string;
}

/** Public shape of the Http service. */
export interface HttpShape {
	readonly request: (input: string | URL | Request, init?: RequestInit) => Effect.Effect<Response, HttpError>;
	/**
	 * Open a streamed response under a per-call AbortController and
	 * watchdog. The Effect resolves when the body promise produces an
	 * iterable; the caller iterates with `for await`. The idle watchdog
	 * lives inside the iterable's `next()` so it stays live during
	 * external iteration.
	 *
	 * Failure channel: `LocalAbort` when the watchdog wins;
	 * `HttpStreamBodyError` when the body rejects on its own. The caller's
	 * catch handler can unwrap the original cause for provider-specific
	 * error formatting.
	 */
	readonly requestStream: <T>(
		opts: HttpStreamOpts<T>,
	) => Effect.Effect<AsyncIterable<T>, LocalAbort | HttpStreamBodyError>;
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
 * Wrap an iterable so its iterator's `return()` / `throw()` runs the
 * supplied cleanup. Used to transfer ownership of the per-call
 * AbortController + caller-signal listener from the open-Effect to the
 * caller, who then drives cleanup via `for await ... break` / natural
 * exhaustion / consumer error.
 */
function wrapWithCleanup<T>(source: AsyncIterable<T>, cleanup: () => void): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T> {
			const inner = source[Symbol.asyncIterator]();
			let cleaned = false;
			const runCleanup = (): void => {
				if (cleaned) return;
				cleaned = true;
				cleanup();
			};
			return {
				next: () =>
					inner.next().then(
						result => {
							if (result.done === true) runCleanup();
							return result;
						},
						error => {
							runCleanup();
							throw error;
						},
					),
				return: async value => {
					runCleanup();
					if (inner.return !== undefined) return inner.return(value);
					return { done: true, value: value as T };
				},
				throw: async err => {
					runCleanup();
					if (inner.throw !== undefined) return inner.throw(err);
					throw err;
				},
			};
		},
	};
}

function buildStreamer(): HttpShape["requestStream"] {
	return <T>(opts: HttpStreamOpts<T>) =>
		Effect.suspend(() => {
			const startedAt = Date.now();
			// Controller lifetime spans the open Effect AND the iterable's
			// iteration — handed off to the iterable wrapper on success.
			const controller = new AbortController();
			let abortListener: (() => void) | undefined;
			const cleanup = (): void => {
				if (opts.callerSignal !== undefined && abortListener !== undefined) {
					opts.callerSignal.removeEventListener("abort", abortListener);
					abortListener = undefined;
				}
				controller.abort();
			};

			// Open: body() runs synchronously inside Effect.suspend so the
			// watchdog race is fair. The body's own rejection is preserved
			// as a tagged error in the failure channel — non-2xx HTTP errors
			// must reach the caller's catch handler as unwrap-able causes
			// (e.g. "rate limit"), not collapsed to LocalAbort.
			const open = Effect.suspend(() => {
				const promise = opts.body(controller.signal);
				return Effect.tryPromise({
					try: () => promise,
					catch: cause => new HttpStreamBodyError({ cause, label: opts.label }),
				});
			});

			const program: Effect.Effect<AsyncIterable<T>, LocalAbort | HttpStreamBodyError> = opts.firstEventWatchdog ===
			undefined
				? open
				: Effect.raceFirst(
						open,
						Effect.fail(
							new LocalAbort({
								kind: opts.firstEventWatchdog.kind,
								durationMs: opts.firstEventWatchdog.timeoutMs,
							}),
						).pipe(Effect.delay(Duration.millis(opts.firstEventWatchdog.timeoutMs))),
					);
			const guarded = opts.callerSignal === undefined ? program : effectFromSignal(opts.callerSignal, program);

			return guarded.pipe(
				Effect.tapError(() => Effect.sync(cleanup)),
				Effect.tapDefect(() => Effect.sync(cleanup)),
				Effect.onInterrupt(() => Effect.sync(cleanup)),
				Effect.map(iterable => {
					if (opts.callerSignal !== undefined && !opts.callerSignal.aborted) {
						abortListener = (): void => controller.abort();
						opts.callerSignal.addEventListener("abort", abortListener, { once: true });
					}
					const firstItemTimeoutMs =
						opts.firstEventWatchdog === undefined
							? undefined
							: Math.max(1, opts.firstEventWatchdog.timeoutMs - (Date.now() - startedAt));
					const wrapped =
						(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
						(opts.idleTimeoutMs === undefined || opts.idleTimeoutMs <= 0)
							? iterable
							: iterateWithIdleTimeout(iterable, {
									idleTimeoutMs: opts.idleTimeoutMs,
									firstItemTimeoutMs,
									errorMessage: `${opts.label} stalled while waiting for the next event`,
									firstItemErrorMessage: `${opts.label} timed out while waiting for the first event`,
									onIdle: () => controller.abort(),
									onFirstItemTimeout: () => controller.abort(),
									createTimeoutError: (phase, timeoutMs) =>
										new LocalAbort({
											kind: phase === "firstItem" ? (opts.firstEventWatchdog?.kind ?? "timeout") : "idle",
											durationMs:
												phase === "firstItem"
													? (opts.firstEventWatchdog?.timeoutMs ?? timeoutMs)
													: timeoutMs,
										}),
								});
					return wrapWithCleanup(wrapped, cleanup);
				}),
			);
		});
}

/**
 * Concrete HttpShape backed by a `fetch` implementation. Exported so
 * non-Effect call sites (provider code that already lives in async
 * functions) can resolve a service value without going through a Layer.
 */
export function makeLiveHttp(fetchFn: typeof fetch = fetch): HttpShape {
	return { request: buildRequester(fetchFn), requestStream: buildStreamer() };
}

/** Live Layer — uses the global `fetch`. */
export const LiveHttp: Layer.Layer<Http> = Layer.succeed(Http)(makeLiveHttp());

/**
 * Construct an Http Layer that delegates to a custom `fetch` implementation.
 * Used by `fetchCodexModels`'s `fetchFn` option (test seam). The streaming
 * method's test seam is the caller-supplied `body` callback, not `fetchFn`,
 * because the body owns its own fetch (codex routes through
 * `requestCodexResponseWithRetry`, openai SDK uses its own client).
 */
export function makeHttpLayer(fetchFn: typeof fetch): Layer.Layer<Http> {
	return Layer.succeed(Http)({
		request: buildRequester(fetchFn),
		requestStream: buildStreamer(),
	});
}
