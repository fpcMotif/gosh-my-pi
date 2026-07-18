import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, test } from "bun:test";
import { ActiveRetryFallback, type ActiveRetryFallbackContext } from "../src/session/active-retry-fallback";
import type { RetryFallbackPolicy, RetryFallbackSelector } from "../src/session/retry-fallback-policy";

function makeModel(provider: string, id: string): Model {
	return fromAny<Model, object>({
		provider,
		id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		contextWindow: 100_000,
		costInputPerToken: 0,
		costOutputPerToken: 0,
		costCacheReadPerToken: 0,
		costCacheWritePerToken: 0,
	});
}

interface FakeContextOverrides {
	candidates?: RetryFallbackSelector[];
	resolveRole?: () => string | undefined;
	getApiKey?: () => Promise<string | undefined>;
	revertPolicy?: "never" | "cooldown-expiry";
	suppressed?: (sel: RetryFallbackSelector) => boolean;
	assertWritable?: () => void;
}

function makeContext(opts: FakeContextOverrides = {}): {
	ctx: ActiveRetryFallbackContext;
	calls: {
		appendModelChange: number;
		setModel: Model[];
		setThinking: (ThinkingLevel | undefined)[];
		emits: Array<{ from: string; to: string; role: string }>;
	};
} {
	const calls = {
		appendModelChange: 0,
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
		modelRegistry: fromAny<ActiveRetryFallbackContext["modelRegistry"], object>({
			find: (provider: string, id: string) => makeModel(provider, id),
			getApiKey: opts.getApiKey ?? (async () => "fake-key"),
		}),
		sessionManager: fromAny<ActiveRetryFallbackContext["sessionManager"], object>({
			assertWritable: opts.assertWritable ?? (() => {}),
			appendModelChange: () => {
				calls.appendModelChange += 1;
				return "msg-id";
			},
		}),
		settings: fromAny<ActiveRetryFallbackContext["settings"], object>({
			getStorage: () => undefined,
		}),
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

	test("tryFallback leaves all session state untouched when persistence is latched", async () => {
		const candidate: RetryFallbackSelector = {
			raw: "openai/secondary",
			provider: "openai",
			id: "secondary",
			thinkingLevel: undefined,
		};
		const persistenceError = new Error("persistence latched");
		const { ctx, calls } = makeContext({
			candidates: [candidate],
			resolveRole: () => "code",
			assertWritable: () => {
				throw persistenceError;
			},
		});
		const fallback = new ActiveRetryFallback(ctx);

		await expect(fallback.tryFallback("openai/primary")).rejects.toBe(persistenceError);
		expect(fallback.role).toBeUndefined();
		expect(calls.setModel).toEqual([]);
		expect(calls.setThinking).toEqual([]);
		expect(calls.appendModelChange).toBe(0);
		expect(calls.emits).toEqual([]);
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

	test("maybeRestorePrimary leaves the active fallback untouched when persistence is latched", async () => {
		const candidate: RetryFallbackSelector = {
			raw: "openai/secondary",
			provider: "openai",
			id: "secondary",
			thinkingLevel: undefined,
		};
		let persistenceLatched = false;
		const persistenceError = new Error("persistence latched");
		const { ctx, calls } = makeContext({
			candidates: [candidate],
			resolveRole: () => "code",
			assertWritable: () => {
				if (persistenceLatched) throw persistenceError;
			},
		});
		const fallback = new ActiveRetryFallback(ctx);

		await expect(fallback.tryFallback("openai/primary")).resolves.toBe(true);
		persistenceLatched = true;
		const before = {
			appendModelChange: calls.appendModelChange,
			setModel: [...calls.setModel],
			setThinking: [...calls.setThinking],
			emits: [...calls.emits],
		};

		await expect(fallback.maybeRestorePrimary()).rejects.toBe(persistenceError);
		expect(fallback.role).toBe("code");
		expect(calls).toEqual(before);
	});
});
