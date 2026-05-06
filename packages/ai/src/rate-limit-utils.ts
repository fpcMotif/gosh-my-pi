/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

import { isUnexpectedSocketCloseMessage } from "./utils/retry";

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: MODEL_CAPACITY > RATE_LIMIT > QUOTA > SERVER_ERROR > UNKNOWN.
 *
 * "resource exhausted" maps to MODEL_CAPACITY (transient, short wait)
 * "quota exceeded" maps to QUOTA_EXHAUSTED (long wait, switch account)
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lower = errorMessage.toLowerCase();

	if (
		lower.includes("capacity") ||
		lower.includes("overloaded") ||
		lower.includes("529") ||
		lower.includes("503") ||
		lower.includes("resource exhausted")
	) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (lower.includes("exhausted") || lower.includes("quota") || lower.includes("usage limit")) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?exceeded|resource.?exhausted/i;

export function isUsageLimitError(errorMessage: string): boolean {
	return USAGE_LIMIT_PATTERN.test(errorMessage);
}

const RETRY_AFTER_MS_PATTERN = /retry-after-ms\s*[:=]\s*(\d+)/i;
const RETRY_AFTER_PATTERN = /retry-after\s*[:=]\s*([^\s,;]+)/i;
const RESET_MS_PATTERN = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i;
const RESET_PATTERN = /x-ratelimit-reset\s*[:=]\s*(\d+)/i;

/**
 * Parse a literal Retry-After value from an error string. Recognizes:
 *   - `retry-after-ms: <ms>`
 *   - `retry-after: <seconds>` or `retry-after: <http-date>`
 *   - `x-ratelimit-reset-ms: <ms>` or `x-ratelimit-reset: <seconds>` (epoch or relative)
 */
export function parseRetryAfterMsFromString(errorMessage: string): number | undefined {
	const now = Date.now();
	const retryAfterMsMatch = RETRY_AFTER_MS_PATTERN.exec(errorMessage);
	if (retryAfterMsMatch) {
		return Math.max(0, Number(retryAfterMsMatch[1]));
	}

	const retryAfterMatch = RETRY_AFTER_PATTERN.exec(errorMessage);
	if (retryAfterMatch) {
		const value = retryAfterMatch[1];
		const seconds = Number(value);
		if (!Number.isNaN(seconds)) {
			return Math.max(0, seconds * 1000);
		}
		const dateMs = Date.parse(value);
		if (!Number.isNaN(dateMs)) {
			return Math.max(0, dateMs - now);
		}
	}

	const resetMsMatch = RESET_MS_PATTERN.exec(errorMessage);
	if (resetMsMatch) {
		const resetMs = Number(resetMsMatch[1]);
		if (!Number.isNaN(resetMs)) {
			if (resetMs > 1_000_000_000_000) {
				return Math.max(0, resetMs - now);
			}
			return Math.max(0, resetMs);
		}
	}

	const resetMatch = RESET_PATTERN.exec(errorMessage);
	if (resetMatch) {
		const resetSeconds = Number(resetMatch[1]);
		if (!Number.isNaN(resetSeconds)) {
			if (resetSeconds > 1_000_000_000) {
				return Math.max(0, resetSeconds * 1000 - now);
			}
			return Math.max(0, resetSeconds * 1000);
		}
	}

	return undefined;
}

/** Reason discriminator on a transient error classification. */
export type TransientReason = "envelope" | "transport" | "rate_limit" | "model_capacity" | "server_error";

const ANTHROPIC_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
const ANTHROPIC_ENVELOPE_BEFORE_START = /before message_start/i;

/**
 * Classify a transient error message into a {@link TransientReason}, or `undefined`
 * if the message is not transient. Used by the retry-policy emission boundary
 * (pi-agent-core) and by the auto-compaction `Error`-throwing retry path.
 */
export function classifyTransient(errorMessage: string): TransientReason | undefined {
	if (ANTHROPIC_ENVELOPE_PATTERN.test(errorMessage) && ANTHROPIC_ENVELOPE_BEFORE_START.test(errorMessage)) {
		return "envelope";
	}

	const reason = parseRateLimitReason(errorMessage);
	if (reason === "RATE_LIMIT_EXCEEDED") return "rate_limit";
	if (reason === "MODEL_CAPACITY_EXHAUSTED") return "model_capacity";
	if (reason === "SERVER_ERROR") return "server_error";

	if (isUnexpectedSocketCloseMessage(errorMessage)) {
		return "transport";
	}

	if (
		/overloaded|provider.?returned.?error|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall/i.test(
			errorMessage,
		)
	) {
		return "transport";
	}

	return undefined;
}

/** Convenience: is this error message classifiable as transient (any reason)? */
export function isTransientErrorMessage(errorMessage: string): boolean {
	return classifyTransient(errorMessage) !== undefined;
}
