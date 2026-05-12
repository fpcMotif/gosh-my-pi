// AbortSignal <-> Effect Fiber bridge.
//
// The codebase threads AbortSignal through every long-running operation
// (LLM streaming, bash exec, tool execution). Effect represents cancellation
// via Fiber.interrupt. These helpers bridge the two so:
//   - Effect programs can be cancelled by an externally provided AbortSignal,
//     without losing the listener after the program completes (avoids leaks
//     on long-lived parent signals).
//   - Effect Fibers can expose an AbortController.signal to legacy APIs that
//     require a real AbortSignal.

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Run `program` and interrupt the resulting fiber when `signal` aborts.
 *
 * The abort listener is removed in a finalizer so we do not leak a closure
 * keeping the fiber alive on long-lived signals (e.g. the agent's session-wide
 * AbortController which persists across many turns).
 */
export function effectFromSignal<A, E, R>(
	signal: AbortSignal,
	program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
	return Effect.scoped(
		Effect.gen(function* () {
			const fiber = yield* Effect.forkScoped(program);
			const onAbort = (): void => {
				Effect.runFork(Fiber.interrupt(fiber));
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						signal.removeEventListener("abort", onAbort);
					}),
				);
			}
			return yield* Fiber.join(fiber);
		}),
	);
}

/**
 * Expose an AbortSignal whose abort fires when the given fiber is interrupted
 * (or completes with failure). Useful when handing off to legacy APIs that
 * still take an AbortSignal.
 *
 * The returned controller is owned by the caller; aborting it externally has
 * no effect on the fiber (use Fiber.interrupt for that).
 */
export function signalFromFiber(fiber: Fiber.Fiber<unknown, unknown>): AbortSignal {
	const controller = new AbortController();
	Effect.runFork(
		Effect.flatMap(Fiber.await(fiber), exit =>
			Effect.sync(() => {
				if (!controller.signal.aborted && exit._tag !== "Success") {
					controller.abort();
				}
			}),
		),
	);
	return controller.signal;
}
