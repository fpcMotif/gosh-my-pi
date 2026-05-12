// Tagged errors raised by pi-ai providers. Lives here (not in pi-agent-core)
// because the package graph runs pi-agent-core -> pi-ai; provider code in
// pi-ai cannot import from pi-agent-core. The pi-agent-core errors module
// re-exports LocalAbort so existing consumers keep their import path.

import { Data } from "@oh-my-pi/pi-utils/effect";
import { STREAM_STALLED_SUFFIX } from "./utils/idle-iterator";

/**
 * Provider-local abort: the request was cancelled by infrastructure rather
 * than by the caller. Distinguishes timeout (no first-event within the
 * configured budget), idle (stream went silent past the inter-event
 * threshold), and stall (handshake or TLS negotiation never completed) so
 * the UI can surface "request stalled" instead of mis-labelling everything
 * as a user abort. Caller-initiated aborts surface as Effect's interrupt
 * channel, not this tag.
 */
export class LocalAbort extends Data.TaggedError("LocalAbort")<{
	readonly kind: "timeout" | "idle" | "stall";
	readonly durationMs: number;
}> {}

/**
 * Rewrap a `STREAM_STALLED_SUFFIX`-suffixed `Error` thrown by
 * `iterateWithIdleTimeout` as a typed `LocalAbort({ kind: "idle" })`. Used by
 * provider catch boundaries where iteration happens outside `http.requestStream`'s
 * body (option-B pattern in `openai-responses` + `openai-codex-responses`) and
 * by `LiveHttp.requestStream`'s body-time catch (`http.ts`).
 *
 * Returns the original cause unchanged when it doesn't match the stalled-stream
 * shape, so the caller can pass any error through the rewrap unconditionally.
 */
export function rewrapStalledStream(cause: unknown, startTime: number): unknown {
	if (cause instanceof Error && cause.message.endsWith(STREAM_STALLED_SUFFIX)) {
		return new LocalAbort({ kind: "idle", durationMs: Date.now() - startTime });
	}
	return cause;
}

/** Render a `LocalAbort` as a stable `errorMessage` string for assistant-message
 *  emission. Shared across providers so the format never drifts. */
export function formatLocalAbortMessage(providerLabel: string, abort: LocalAbort): string {
	return `${providerLabel} stream ${abort.kind} after ${abort.durationMs}ms`;
}
