import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { describe, expect, test } from "bun:test";
import {
	ActiveRetryFallback,
	type ActiveRetryFallbackContext,
} from "../src/session/active-retry-fallback";
import type { RetryFallbackPolicy, RetryFallbackSelector } from "../src/session/retry-fallback-policy";

function makeModel(provider: string, id: string): Model {
	return {
		provider,
		id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		contextWindow: 100_000,
		costInputPerToken: 0,
		costOutputPerToken: 0,
		costCacheReadPerToken: 0,
		costCacheWritePerToken: 0,
	} as unknown as Model;
}

interface FakeContextOverrides {
	candidates?: RetryFallbackSelector[];
	resolveRole?: () => string | undefined;
	getApiKey?: () => Promise<string | undefined>;
	revertPolicy?: "never" | "cooldown-expiry";
	suppressed?: (sel: RetryFallbackSelector) => boolean;
}

function makeContext(opts: FakeContextOverrides = {}): {
	ctx: ActiveRetryFallbackContext;
	calls: { setModel: Model[]; setThinking: (ThinkingLevel | undefined)[]; emits: Array<{ from: string; to: string; role: string }> };
} {
	const calls = {
		setModel: [] as Model[],
		setThinking: [] as (ThinkingLevel | undefined)[],
		emits: [] as Array<{ from: string; to: string; role: string }>,
	};
	let currentModel: Model | undefined = makeModel("openai", "primary");
	const policy: Partial<RetryFallbackPolicy> = {
		findCandidates: () => opts.candidates ?? [],
		resolveRole: () => opts.resolveRole?.() ?? undefined,
		isSelectorSuppressed: opts.suppressed ?? (() => false),
		getRevertPolicy: () => opts.revertPolicy ?? "cooldown-expiry",
	};
	const ctx: ActiveRetryFallbackContext = {
		sessionId: "test-session",
		modelRegistry: {
			find: (provider: string, id: string) => makeModel(provider, id),
			getApiKey: opts.getApiKey ?? (async () => "fake-key"),
		} as unknown as ActiveRetryFallbackContext["modelRegistry"],
		sessionManager: {
			appendModelChange: () => "msg-id",
		} as unknown as ActiveRetryFallbackContext["sessionManager"],
		settings: {
			getStorage: () => undefined,
		} as unknown as ActiveRetryFallbackContext["settings"],
		policy: policy as RetryFallbackPolicy,
		getModel: () => currentModel,
		getThinkingLevel: () => undefined,
		setModelWithReset: model => {
			calls.setModel.push(model);
			currentModel = model;
		},
		setThinkingLevel: level => calls.setThinking.push(level),
		emitFallbackApplied: async payload => {
			calls.emits.push(payload);
		},
	};
	return { ctx, calls };
}

describe("ActiveRetryFallback", () => {
	test("starts with no role", () => {
		const { ctx } = makeContext();
		const fallback = new ActiveRetryFallback(ctx);
		expect(fallback.role).toBeUndefined();
	});

	test("clear() resets state", async () => {
		const candidate: RetryFallbackSelector = {
			raw: "openai/secondary",
			provider: "openai",
			id: "secondary",
			thinkingLevel: undefined,
		};
		const { ctx } = makeContext({ candidates: [candidate], resolveRole: () => "code" });
		const fallback = new ActiveRetryFallback(ctx);
		const applied = await fallback.tryFallback("openai/primary");
		expect(applied).toBe(true);
		expect(fallback.role).toBe("code");
		fallback.clear();
		expect(fallback.role).toBeUndefined();
	});

	test("tryFallback applies first non-suppressed candidate and emits", async () => {
		const candidate: RetryFallbackSelector = {
			raw: "openai/secondary",
			provider: "openai",
			id: "secondary",
			thinkingLevel: undefined,
		};
		const { ctx, calls } = makeContext({ candidates: [candidate], resolveRole: () => "code" });
		const fallback = new ActiveRetryFallback(ctx);
		const applied = await fallback.tryFallback("openai/primary");
		expect(applied).toBe(true);
		expect(calls.setModel).toHaveLength(1);
		expect(calls.setModel[0].id).toBe("secondary");
		expect(calls.emits).toEqual([{ from: "openai/primary", to: "openai/secondary", role: "code" }]);
	});

	test("tryFallback skips suppressed selectors", async () => {
		const candidate: RetryFallbackSelector = {
			raw: "openai/secondary",
			provider: "openai",
			id: "secondary",
			thinkingLevel: undefined,
		};
		const { ctx, calls } = makeContext({
			candidates: [candidate],
			resolveRole: () => "code",
			suppressed: () => true,
		});
		const fallback = new ActiveRetryFallback(ctx);
		const applied = await fallback.tryFallback("openai/primary");
		expect(applied).toBe(false);
		expect(calls.setModel).toHaveLength(0);
	});

	test("tryFallback returns false when no role resolves", async () => {
		const { ctx } = makeContext({ resolveRole: () => undefined });
		const fallback = new ActiveRetryFallback(ctx);
		expect(await fallback.tryFallback("openai/primary")).toBe(false);
	});

	test("maybeRestorePrimary is a no-op when no fallback is active", async () => {
		const { ctx, calls } = makeContext();
		const fallback = new ActiveRetryFallback(ctx);
		await fallback.maybeRestorePrimary();
		expect(calls.setModel).toHaveLength(0);
	});

	test("maybeRestorePrimary skips when revertPolicy is 'never'", async () => {
		const candidate: RetryFallbackSelector = {
			raw: "openai/secondary",
			provider: "openai",
			id: "secondary",
			thinkingLevel: undefined,
		};
		const { ctx, calls } = makeContext({
			candidates: [candidate],
			resolveRole: () => "code",
			revertPolicy: "never",
		});
		const fallback = new ActiveRetryFallback(ctx);
		await fallback.tryFallback("openai/primary");
		const setModelCountAfterApply = calls.setModel.length;
		await fallback.maybeRestorePrimary();
		expect(calls.setModel).toHaveLength(setModelCountAfterApply); // no restore
		expect(fallback.role).toBe("code"); // stays active
	});
});
