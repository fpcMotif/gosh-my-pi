import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { describe, expect, test } from "bun:test";
import { RetryController, type RetryControllerContext } from "../src/session/retry-controller";

interface FakeContextOptions {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	markUsageLimitReached?: () => Promise<boolean>;
	tryFallback?: () => Promise<boolean>;
}

function makeContext(opts: FakeContextOptions = {}): {
	ctx: RetryControllerContext;
	calls: { emits: unknown[]; continues: unknown[]; replaceMessages: unknown[][]; noteCooldown: number };
} {
	const calls = {
		emits: [] as unknown[],
		continues: [] as unknown[],
		replaceMessages: [] as unknown[][],
		noteCooldown: 0,
	};
	const fakeMessages: AssistantMessage[] = [];
	const ctx: RetryControllerContext = {
		sessionId: "test-session",
		settings: {
			getGroup: () => ({
				enabled: opts.enabled ?? true,
				maxRetries: opts.maxRetries ?? 3,
				baseDelayMs: opts.baseDelayMs ?? 1,
			}),
		} as unknown as RetryControllerContext["settings"],
		agent: {
			state: { messages: fakeMessages },
			replaceMessages: (msgs: unknown[]) => calls.replaceMessages.push(msgs),
		} as unknown as RetryControllerContext["agent"],
		modelRegistry: {
			authStorage: {
				markUsageLimitReached: opts.markUsageLimitReached ?? (async () => false),
			},
		} as unknown as RetryControllerContext["modelRegistry"],
		retryFallbackPolicy: {
			noteCooldown: () => {
				calls.noteCooldown++;
			},
		} as unknown as RetryControllerContext["retryFallbackPolicy"],
		activeRetryFallback: {
			tryFallback: opts.tryFallback ?? (async () => false),
		} as unknown as RetryControllerContext["activeRetryFallback"],
		getModel: () => ({ provider: "openai", baseUrl: "https://example.invalid" }),
		getModelSelector: () => "openai/gpt-test",
		getPromptGeneration: () => 1,
		emitSessionEvent: async event => {
			calls.emits.push(event);
		},
		scheduleAgentContinue: options => {
			calls.continues.push(options);
		},
	};
	return { ctx, calls };
}

function assistantError(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("RetryController", () => {
	test("starts at attempt 0, not retrying", () => {
		const { ctx } = makeContext();
		const retry = new RetryController(ctx);
		expect(retry.attempt).toBe(0);
		expect(retry.isRetrying).toBe(false);
		expect(retry.waitFor()).toBeUndefined();
	});

	test("isRetryable returns true for usage_limit and transient errors", () => {
		const { ctx } = makeContext();
		const retry = new RetryController(ctx);
		const msg = assistantError("rate limited");
		expect(retry.isRetryable(msg, { kind: "usage_limit", retryAfterMs: 1000 })).toBe(true);
		expect(retry.isRetryable(msg, { kind: "transient" })).toBe(true);
		expect(retry.isRetryable(msg, { kind: "context_overflow" })).toBe(false);
		expect(retry.isRetryable(msg, { kind: "fatal" })).toBe(false);
		expect(retry.isRetryable(msg, undefined)).toBe(false);
	});

	test("isRetryable returns false for non-error stop reason regardless of kind", () => {
		const { ctx } = makeContext();
		const retry = new RetryController(ctx);
		const successMsg: AssistantMessage = { ...assistantError(""), stopReason: "stop", errorMessage: undefined };
		// stopReason gate: even with a transient errorKind, a non-error stopReason is not retried.
		expect(retry.isRetryable(successMsg, { kind: "transient" })).toBe(false);
		expect(
			retry.isRetryable({ ...successMsg, stopReason: "aborted" }, { kind: "usage_limit", retryAfterMs: 1 }),
		).toBe(false);
	});

	test("handle() returns false when retry is disabled", async () => {
		const { ctx } = makeContext({ enabled: false });
		const retry = new RetryController(ctx);
		const result = await retry.handle(assistantError("x"), { kind: "transient" });
		expect(result).toBe(false);
		expect(retry.attempt).toBe(0);
	});

	test("handle() schedules continue on first transient retry", async () => {
		const { ctx, calls } = makeContext({ baseDelayMs: 0 });
		const retry = new RetryController(ctx);
		const result = await retry.handle(assistantError("overloaded"), { kind: "transient" });
		expect(result).toBe(true);
		expect(retry.attempt).toBe(1);
		expect(retry.isRetrying).toBe(true);
		expect(calls.continues).toHaveLength(1);
		expect(calls.emits.some(e => (e as { type: string }).type === "auto_retry_start")).toBe(true);
		// model fallback path called noteCooldown
		expect(calls.noteCooldown).toBe(1);
	});

	test("handle() emits final failure when max retries exceeded", async () => {
		const { ctx, calls } = makeContext({ baseDelayMs: 0, maxRetries: 1 });
		const retry = new RetryController(ctx);
		// First call: succeeds (attempt=1)
		await retry.handle(assistantError("overloaded"), { kind: "transient" });
		// Second call: attempt becomes 2 > maxRetries, emits final failure
		const result = await retry.handle(assistantError("overloaded"), { kind: "transient" });
		expect(result).toBe(false);
		expect(retry.attempt).toBe(0); // reset
		const finalEvent = calls.emits.find(
			e =>
				(e as { type: string; success?: boolean }).type === "auto_retry_end" &&
				(e as { success?: boolean }).success === false,
		);
		expect(finalEvent).toBeDefined();
	});

	test("consumeSuccessfulAttempt returns and resets attempt", () => {
		const { ctx } = makeContext();
		const retry = new RetryController(ctx);
		// Manually drive state by calling handle once
		// (skipped — just test the helper's reset semantics)
		expect(retry.consumeSuccessfulAttempt()).toBe(0);
		expect(retry.attempt).toBe(0);
	});

	test("abort() cancels and resolves the retry promise", async () => {
		const { ctx } = makeContext({ baseDelayMs: 50 });
		const retry = new RetryController(ctx);
		const handlePromise = retry.handle(assistantError("overloaded"), { kind: "transient", retryAfterMs: 50 });
		expect(retry.isRetrying).toBe(true);
		const waited = retry.waitFor();
		expect(waited).toBeDefined();
		retry.abort();
		await waited;
		await handlePromise;
		expect(retry.isRetrying).toBe(false);
	});

	test("usage_limit triggers credential switch when accounts available", async () => {
		const { ctx, calls } = makeContext({
			baseDelayMs: 0,
			markUsageLimitReached: async () => true, // switched
		});
		const retry = new RetryController(ctx);
		const result = await retry.handle(assistantError("usage limit"), {
			kind: "usage_limit",
			retryAfterMs: 5000,
		});
		expect(result).toBe(true);
		// noteCooldown is skipped when credential switch succeeds
		expect(calls.noteCooldown).toBe(0);
	});
});
