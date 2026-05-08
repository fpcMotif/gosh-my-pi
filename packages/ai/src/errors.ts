// Tagged errors raised by pi-ai providers. Lives here (not in pi-agent-core)
// because the package graph runs pi-agent-core -> pi-ai; provider code in
// pi-ai cannot import from pi-agent-core. The pi-agent-core errors module
// re-exports LocalAbort so existing consumers keep their import path.

import { Data } from "@oh-my-pi/pi-utils/effect";

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
