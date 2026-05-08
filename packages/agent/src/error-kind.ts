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
import type { AgentTaggedError } from "./errors";

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
export function classifyAssistantError(message: AssistantMessage, contextWindow?: number): AgentErrorKind | undefined {
	if (message.stopReason !== "error") return undefined;
	const errorMessage = message.errorMessage;
	if (errorMessage === null || errorMessage === undefined || errorMessage === "") {
		return { kind: "fatal" };
	}

	if (isContextOverflow(message, contextWindow)) {
		if (contextWindow === null || contextWindow === undefined || contextWindow === 0) {
			return { kind: "context_overflow" };
		}
		const usedTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		return usedTokens > contextWindow ? { kind: "context_overflow", usedTokens } : { kind: "context_overflow" };
	}

	if (isUsageLimitError(errorMessage)) {
		const retryAfterMs =
			parseRetryAfterMsFromString(errorMessage) ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
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

/**
 * One-way bridge from a typed Effect failure (`AgentTaggedError`) to the
 * event-stream taxonomy (`AgentErrorKind`). Used at the boundary where an
 * Effect program's failure becomes an emitted assistant-message error.
 *
 * Exhaustive over `AgentTaggedError._tag`: TypeScript will fail compilation
 * if a new tagged error is added without a clause here.
 */
export function errorToKind(error: AgentTaggedError): AgentErrorKind {
	switch (error._tag) {
		case "ContextOverflow":
			return error.usedTokens !== undefined
				? { kind: "context_overflow", usedTokens: error.usedTokens }
				: { kind: "context_overflow" };
		case "ProviderHttpError":
			return { kind: "transient" };
		case "UsageLimitError":
			return { kind: "usage_limit", retryAfterMs: error.retryAfterMs };
		case "LocalAbort":
			// timeout / idle / stall are all transport-layer issues from the
			// caller's perspective — collapse to the existing `transport` reason.
			return { kind: "transient", reason: "transport" };
		case "TurnAborted":
			return { kind: "transient" };
		case "AgentBusy":
		case "ConfigInvalid":
		case "ToolExecError":
		case "SessionStorageError":
		case "SubprocessAborted":
			return { kind: "fatal" };
	}
}
