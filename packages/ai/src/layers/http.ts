// Http Layer — wraps `fetch` as an Effect service so call sites can be
// provided with a real fetch (LiveHttp) or a test stub (makeHttpLayer).
//
// Scope (P1): minimal seam for codex.ts model discovery. Other providers
// (kimi.ts, openai-responses.ts) still use the OpenAI SDK / pass-through
// streams and will migrate later when their fetch boundaries are exposed.

import { Context, Data, Effect, Layer } from "@oh-my-pi/pi-utils/effect";

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

/** Public shape of the Http service. */
export interface HttpShape {
	readonly request: (input: RequestInfo, init?: RequestInit) => Effect.Effect<Response, HttpError>;
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

/** Live Layer — uses the global `fetch`. */
export const LiveHttp: Layer.Layer<Http> = Layer.succeed(Http)({ request: buildRequester(fetch) });

/**
 * Construct an Http Layer that delegates to a custom `fetch` implementation.
 * Used by `fetchCodexModels`'s `fetchFn` option (test seam).
 */
export function makeHttpLayer(fetchFn: typeof fetch): Layer.Layer<Http> {
	return Layer.succeed(Http)({ request: buildRequester(fetchFn) });
}
