import { isTransientErrorMessage, isUsageLimitError, parseRetryAfterMsFromString } from "@oh-my-pi/pi-ai";
import { abortableSleep, logger } from "@oh-my-pi/pi-utils";

/**
 * Subset of the `retry.*` settings group needed by {@link runCompactionWithRetry}.
 */
export interface CompactionRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface CompactionRetryOptions<T> {
	attempt: () => Promise<T>;
	retrySettings: CompactionRetrySettings;
	/** Used in retry log lines. */
	modelLabel: string;
	/** When true, "next-candidate" bail is disabled — wait out long delays here. */
	isLastCandidate: boolean;
	/**
	 * Cap above which the loop bails to the next candidate (when one exists)
	 * instead of waiting. Defaults to 30s.
	 */
	maxAcceptableDelayMs?: number;
	signal: AbortSignal;
}

export interface CompactionRetryResult<T> {
	/** The successful result, or undefined if all attempts failed. */
	result: T | undefined;
	/** The last observed error when no result was produced. */
	lastError: unknown;
}

/**
 * Run a compaction attempt with transient-error retry, exponential backoff,
 * and respect for `Retry-After` headers parsed from the error string.
 *
 * Used by the auto-compaction orchestrator inside the per-candidate loop.
 * Extracted so the retry-classification + backoff math has a clean test
 * surface and the orchestrator's outer loop stays readable.
 */
export async function runCompactionWithRetry<T>(options: CompactionRetryOptions<T>): Promise<CompactionRetryResult<T>> {
	const { attempt, retrySettings, modelLabel, isLastCandidate, signal } = options;
	const maxAcceptableDelayMs = options.maxAcceptableDelayMs ?? 30_000;
	let lastError: unknown;
	let attemptIndex = 0;
	while (true) {
		try {
			const result = await attempt();
			return { result, lastError: undefined };
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			const message = error instanceof Error ? error.message : String(error);
			const retryAfterMs = parseRetryAfterMsFromString(message);
			const shouldRetry =
				retrySettings.enabled &&
				attemptIndex < retrySettings.maxRetries &&
				(retryAfterMs !== undefined || isTransientErrorMessage(message) || isUsageLimitError(message));
			if (!shouldRetry) {
				lastError = error;
				return { result: undefined, lastError };
			}

			const baseDelayMs = retrySettings.baseDelayMs * 2 ** attemptIndex;
			const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

			if (delayMs > maxAcceptableDelayMs && !isLastCandidate) {
				logger.warn("Auto-compaction retry delay too long, trying next model", {
					delayMs,
					retryAfterMs,
					error: message,
					model: modelLabel,
				});
				lastError = error;
				return { result: undefined, lastError };
			}

			attemptIndex++;
			logger.warn("Auto-compaction failed, retrying", {
				attempt: attemptIndex,
				maxRetries: retrySettings.maxRetries,
				delayMs,
				retryAfterMs,
				error: message,
				model: modelLabel,
			});
			await abortableSleep(delayMs, signal);
		}
	}
}
