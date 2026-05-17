import { Cause, Effect, Exit, Stream } from "@oh-my-pi/pi-utils/effect";
import type { AssistantMessageEvent } from "./types";
import type { AssistantMessageEventStream } from "./utils/event-stream";

/**
 * Bridges an Effect Stream to the existing AssistantMessageEventStream.
 *
 * - On success: ends the eventStream gracefully.
 * - On failure, defect, or caller-signal interruption: signals
 *   `eventStream.error(...)` so consumers iterating the stream don't park
 *   forever waiting for the next event.
 *
 * `runPromiseExit` is the boundary (not `runPromise` + `matchEffect`) so the
 * terminal Exit is observed for *every* outcome — a `matchEffect` over the
 * typed error channel structurally cannot see defects or interrupts, which
 * would otherwise leak as unhandled rejections and leave the eventStream
 * un-ended.
 *
 * Providers that want a structured `{ type: "error" }` event (with provider
 * context, usage, etc.) should map errors to events via `Stream.catch` *before*
 * passing the stream here — see `kimi.ts` for the reference pattern.
 */
export function runEffectStream(
	effectStream: Stream.Stream<AssistantMessageEvent, Error>,
	eventStream: AssistantMessageEventStream,
	options?: { signal?: AbortSignal },
): Promise<void> {
	const program = Stream.runForEach(effectStream, event => Effect.sync(() => eventStream.push(event)));

	return Effect.runPromiseExit(program, { signal: options?.signal }).then(exit => {
		if (Exit.isFailure(exit)) {
			eventStream.error(Cause.squash(exit.cause));
		} else {
			eventStream.end();
		}
	});
}
