import {
	type AssistantMessage,
	calculateRateLimitBackoffMs,
	classifyTransient,
	isContextOverflow,
	isUsageLimitError,
	parseRateLimitReason,
	parseRetryAfterMsFromString,
	type TransientReason,
} from "@oh-my-pi/pi-ai";

export type { TransientReason };

/**
 * Typed classification of an assistant-message error, attached to AgentEvent
 * variants `agent_end` and `message_end` when the message has
 * `stopReason === "error"`. Computed once at the emission boundary so
 * consumers don't re-parse `errorMessage`.
 */
export type AgentErrorKind =
	| { kind: "context_overflow"; usedTokens?: number }
	| { kind: "usage_limit"; retryAfterMs: number }
	| { kind: "transient"; retryAfterMs?: number; reason?: TransientReason }
	| { kind: "fatal" };

/**
 * Classify an assistant message that has stopped with an error. Returns
 * `undefined` when the message did not error (or is missing an error string).
 *
 * Order matters:
 *   1. Context overflow takes precedence (handled by compaction, never retried)
 *   2. Usage limit (persistent — needs credential switch)
 *   3. Transient (transport / envelope / rate / capacity / 5xx)
 *   4. Fatal otherwise
 */
export function classifyAssistantError(
	message: AssistantMessage,
	contextWindow?: number,
): AgentErrorKind | undefined {
	if (message.stopReason !== "error") return undefined;
	const errorMessage = message.errorMessage;
	if (errorMessage === null || errorMessage === undefined || errorMessage === "") {
		return { kind: "fatal" };
	}

	if (isContextOverflow(message, contextWindow)) {
		const usedTokens =
			contextWindow !== null && contextWindow !== undefined && contextWindow !== 0
				? message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
				: undefined;
		return usedTokens !== undefined && usedTokens > contextWindow!
			? { kind: "context_overflow", usedTokens }
			: { kind: "context_overflow" };
	}

	if (isUsageLimitError(errorMessage)) {
		const retryAfterMs =
			parseRetryAfterMsFromString(errorMessage) ??
			calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
		return { kind: "usage_limit", retryAfterMs };
	}

	const transientReason = classifyTransient(errorMessage);
	if (transientReason !== undefined) {
		const retryAfterMs = parseRetryAfterMsFromString(errorMessage);
		return retryAfterMs !== undefined
			? { kind: "transient", retryAfterMs, reason: transientReason }
			: { kind: "transient", reason: transientReason };
	}

	return { kind: "fatal" };
}
