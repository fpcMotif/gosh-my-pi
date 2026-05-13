// Tagged-error tree for the ai package — currently a single typed
// failure raised by the streaming providers / Http Layer when a request
// is cancelled by transport-layer infrastructure (watchdog, idle timer,
// handshake stall) rather than by the caller.
//
// Caller-initiated cancellation surfaces as Effect's interrupt channel
// (via effectFromSignal in @oh-my-pi/pi-utils) and never reaches this
// tag — keeping the two cases distinct lets the UI report
// "request stalled" without mis-labelling user cancellations.
//
// Re-exported from @oh-my-pi/pi-agent-core so AgentTaggedError keeps a
// single import surface; pi-agent-core depends on pi-ai (not the
// other way round) so the canonical home is here.

import { Data } from "@oh-my-pi/pi-utils/effect";

export class LocalAbort extends Data.TaggedError("LocalAbort")<{
	readonly kind: "timeout" | "idle" | "stall";
	readonly durationMs: number;
}> {}

export function unwrapLocalAbort(error: unknown): LocalAbort | undefined {
	if (error instanceof LocalAbort) return error;
	const cause = (error as { cause?: unknown } | null | undefined)?.cause;
	if (cause instanceof LocalAbort) return cause;
	return undefined;
}

export function formatLocalAbortMessage(prefix: string, error: LocalAbort): string {
	return `${prefix} ${error.kind} after ${error.durationMs}ms`;
}
