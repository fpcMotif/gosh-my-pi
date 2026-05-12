import { Effect, Stream } from "@oh-my-pi/pi-utils/effect";
import type { AssistantMessageEvent } from "./types";
import type { AssistantMessageEventStream } from "./utils/event-stream";

/**
 * Bridges an Effect Stream to the existing AssistantMessageEventStream.
 *
 * - On success: ends the eventStream gracefully.
 * - On failure: signals `eventStream.error(err)` so consumers iterating the
 *   stream don't park forever waiting for the next event.
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
	const program = Stream.runForEach(effectStream, event => {
		eventStream.push(event);
		return Effect.void;
	}).pipe(
		Effect.matchEffect({
			onFailure: err => {
				eventStream.error(err);
				return Effect.void;
			},
			onSuccess: () => {
				eventStream.end();
				return Effect.void;
			},
		}),
	);

	return Effect.runPromise(program, { signal: options?.signal });
}

/**
 * Helper to convert an AsyncIterable to an Effect Stream.
 */
export function fromAsyncIterable<A>(iterable: AsyncIterable<A>): Stream.Stream<A, Error> {
	return Stream.fromAsyncIterable(iterable, error => (error instanceof Error ? error : new Error(String(error))));
}
