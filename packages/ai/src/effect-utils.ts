import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import { isCopilotRetryableError } from "./utils/retry";

/**
 * Creates an Effect retry policy for Copilot model errors.
 *
 * `recurs(2)` = 2 retries on top of the initial attempt = 3 total calls,
 * matching the previous hand-rolled loop's MAX_ATTEMPTS = 3.
 * Delays: 400 ms, 800 ms (matches `BASE_DELAY * (attempt + 1)`).
 */
export const copilotRetryPolicy = Schedule.recurs(2).pipe(
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
