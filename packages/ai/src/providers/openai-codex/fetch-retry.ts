// Effect-based retry policy for Codex one-shot POSTs.
//
// Owns:
//   - Iterating against a transient HTTP status (CODEX_RETRYABLE_STATUS) up
//     to CODEX_MAX_RETRIES with linear back-off (CODEX_RETRY_DELAY_MS * n).
//   - Honouring server-provided 429 `Retry-After` / "try again in Xs"
//     deadlines while budgeting total 429 wait time to
//     CODEX_RATE_LIMIT_BUDGET_MS.
//   - Bailing on persistent 429s (usage-limit exhaustion) so credential
//     rotation can happen one layer up in the agent session.

import { Effect } from "@oh-my-pi/pi-utils/effect";
import { isUsageLimitError } from "../../rate-limit-utils";
import { retryWithState, type RetryDecision } from "../../utils/retry";

export const CODEX_RETRY_DELAY_MS = 500;
export const CODEX_MAX_RETRIES = 5;
export const CODEX_RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
/** Max total time to spend retrying 429s with server-provided delays (5 minutes). */
export const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;

interface CodexFetchRetryState {
	readonly attempt: number;
	readonly rateLimitTimeSpentMs: number;
}

type CodexFetchRetryDecision = RetryDecision<Response, CodexFetchRetryState, unknown>;

const INITIAL_STATE: CodexFetchRetryState = { attempt: 0, rateLimitTimeSpentMs: 0 };

/**
 * Resolve `fetch(url, init)` while transparently retrying transient HTTP
 * failures per Codex's retry policy. The supplied `signal` is honored both
 * for the outer Effect run and the inner `fetch` (whichever rejects first
 * wins the race).
 */
export function requestCodexResponseWithRetry(
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
): Promise<Response> {
	return Effect.runPromise(codexFetchRetryEffect(url, init, signal, INITIAL_STATE), { signal });
}

/** @internal Exported for tests that want to drive the Effect directly. */
export function codexFetchRetryEffect(
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
	state: CodexFetchRetryState,
): Effect.Effect<Response, unknown> {
	return retryWithState<Response, CodexFetchRetryState, unknown>({
		initialState: state,
		attempt: () =>
			Effect.tryPromise({
				try: () => fetch(url, { ...init, signal: signal ?? init.signal }),
				catch: cause => cause,
			}),
		onSuccess: (response, currentState) => onCodexFetchSuccess(signal, currentState, response),
		onFailure: (error, currentState) => onCodexFetchFailure(signal, currentState, error),
	});
}

function onCodexFetchSuccess(
	signal: AbortSignal | undefined,
	state: CodexFetchRetryState,
	response: Response,
): Effect.Effect<CodexFetchRetryDecision, unknown> {
	if (!CODEX_RETRYABLE_STATUS.has(response.status)) {
		return Effect.succeed({ _tag: "return", value: response });
	}
	if (signal?.aborted) {
		return Effect.succeed({ _tag: "return", value: response });
	}

	return Effect.tryPromise({
		try: () => response.clone().text(),
		catch: cause => cause,
	}).pipe(
		Effect.matchEffect({
			onFailure: error => onCodexFetchFailure(signal, state, error),
			onSuccess: errorBody => Effect.succeed(decideCodexFetchRetry(response, state, errorBody)),
		}),
	);
}

function decideCodexFetchRetry(
	response: Response,
	state: CodexFetchRetryState,
	errorBody: string,
): CodexFetchRetryDecision {
	// Usage-limit errors are persistent (account allocation exhausted) so retrying
	// with the same credential is futile. Bail out so the agent session layer
	// can rotate credentials instead.
	if (response.status === 429 && isUsageLimitError(errorBody)) {
		return { _tag: "return", value: response };
	}

	const { delay, serverProvided } = parseCodexRetryDelayMs(response, state.attempt, errorBody);
	if (response.status === 429 && serverProvided) {
		if (state.rateLimitTimeSpentMs + delay > CODEX_RATE_LIMIT_BUDGET_MS) {
			return { _tag: "return", value: response };
		}
		return {
			_tag: "retry",
			delayMs: delay,
			nextState: {
				attempt: state.attempt + 1,
				rateLimitTimeSpentMs: state.rateLimitTimeSpentMs + delay,
			},
		};
	}

	if (state.attempt >= CODEX_MAX_RETRIES) return { _tag: "return", value: response };

	return {
		_tag: "retry",
		delayMs: delay,
		nextState: { attempt: state.attempt + 1, rateLimitTimeSpentMs: state.rateLimitTimeSpentMs },
	};
}

function onCodexFetchFailure(
	signal: AbortSignal | undefined,
	state: CodexFetchRetryState,
	error: unknown,
): Effect.Effect<CodexFetchRetryDecision, unknown> {
	if (state.attempt >= CODEX_MAX_RETRIES || signal?.aborted) return Effect.fail(error);
	return Effect.succeed({
		_tag: "retry",
		delayMs: CODEX_RETRY_DELAY_MS * (state.attempt + 1),
		nextState: {
			attempt: state.attempt + 1,
			rateLimitTimeSpentMs: state.rateLimitTimeSpentMs,
		},
	});
}

/**
 * Parse a Codex retry delay from a Response. Honours both the `Retry-After`
 * header (seconds or HTTP date) and the in-body "try again in Xs / Xms"
 * convention OpenAI uses for 429s.
 */
export function parseCodexRetryDelayMs(
	response: Response | null,
	attempt: number,
	errorBody?: string,
): { delay: number; serverProvided: boolean } {
	const retryAfter = response?.headers?.get("retry-after") ?? null;
	if (retryAfter !== null && retryAfter.length > 0) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) {
			return { delay: Math.max(0, seconds * 1000), serverProvided: true };
		}
		const parsedDate = Date.parse(retryAfter);
		if (!Number.isNaN(parsedDate)) {
			return { delay: Math.max(0, parsedDate - Date.now()), serverProvided: true };
		}
	}
	if (errorBody !== undefined && errorBody.length > 0) {
		const msMatch = /try again in\s+(\d+(?:\.\d+)?)\s*ms/i.exec(errorBody);
		if (msMatch !== null) {
			const ms = Number(msMatch[1]);
			if (Number.isFinite(ms)) return { delay: Math.max(ms, 100), serverProvided: true };
		}
		const sMatch = /try again in\s+(\d+(?:\.\d+)?)\s*s(?:ec)?/i.exec(errorBody);
		if (sMatch !== null) {
			const seconds = Number(sMatch[1]);
			if (Number.isFinite(seconds)) return { delay: Math.max(seconds * 1000, 100), serverProvided: true };
		}
	}
	return { delay: CODEX_RETRY_DELAY_MS * (attempt + 1), serverProvided: false };
}
