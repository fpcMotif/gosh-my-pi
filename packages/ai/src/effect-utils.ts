import { Duration, Effect, Schedule } from "@oh-my-pi/pi-utils/effect";
import { isCopilotRetryableError } from "./utils/retry";

/**
 * Two-retry base schedule (3 total attempts) used as the seed for
 * provider-specific retry policies. Future workflows compose this with
 * `Schedule.addDelay`, `Schedule.intersect`, etc.
 */
export const basicRetryPolicy = Schedule.recurs(2);

/**
 * Creates an Effect retry policy for Copilot model errors.
 *
 * Composes `basicRetryPolicy` (recurs 2) with a linear back-off matching the
 * previous hand-rolled loop: delays 400 ms, 800 ms (`BASE_DELAY * (attempt + 1)`).
 */
export const copilotRetryPolicy = basicRetryPolicy.pipe(
	Schedule.addDelay(attempt => Effect.succeed(Duration.millis(400 * (attempt + 1)))),
);

/**
 * Executes a function with Copilot-specific retry logic using Effect.
 */
export function withCopilotRetry<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	options: { provider: string },
): Effect.Effect<A, E, R> {
	if (options.provider !== "github-copilot") {
		return effect;
	}

	return effect.pipe(
		Effect.retry({
			schedule: copilotRetryPolicy,
			while: isCopilotRetryableError,
		}),
	);
}
