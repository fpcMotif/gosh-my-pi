import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { CompactionSettings } from "../src/config/settings-schema";
import {
	decideContextPressure,
	orderContextPressureModelCandidates,
	resolveContextPromotionConfiguredTarget,
} from "../src/session/context-pressure-policy";

function model(id: string, contextWindow: number, overrides: Partial<Model> = {}): Model {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		...overrides,
	} as Model;
}

function compactionSettings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		strategy: "context-full",
		thresholdPercent: -1,
		thresholdTokens: 800,
		reserveTokens: 100,
		keepRecentTokens: 200,
		handoffSaveToDisk: false,
		autoContinue: true,
		remoteEnabled: false,
		remoteEndpoint: undefined,
		idleEnabled: true,
		idleThresholdTokens: -1,
		idleTimeoutSeconds: 60,
		...overrides,
	};
}

function assistantMessage(currentModel: Model, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: currentModel.api,
		provider: currentModel.provider,
		model: currentModel.id,
		usage: {
			input: 850,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 850,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_000,
		...overrides,
	};
}

describe("ContextPressurePolicy", () => {
	it("routes current-model overflow to promotion or retry compaction", () => {
		const currentModel = model("small", 1_000);
		const decision = decideContextPressure({
			assistantMessage: assistantMessage(currentModel, {
				stopReason: "error",
				errorMessage: "context_length_exceeded: input exceeds the context window",
			}),
			currentModel,
			compactionSettings: compactionSettings(),
			skipAbortedCheck: true,
			errorIsFromBeforeCompaction: false,
		});

		expect(decision).toEqual({
			kind: "promote-or-compact",
			reason: "overflow",
			willRetry: true,
			compactIfPromotionUnavailable: true,
		});
	});

	it("skips overflow errors retained from before the latest compaction", () => {
		const currentModel = model("small", 1_000);
		const decision = decideContextPressure({
			assistantMessage: assistantMessage(currentModel, {
				stopReason: "error",
				errorMessage: "context_length_exceeded: input exceeds the context window",
			}),
			currentModel,
			compactionSettings: compactionSettings(),
			skipAbortedCheck: true,
			errorIsFromBeforeCompaction: true,
		});

		expect(decision).toEqual({ kind: "skip", reason: "stale-overflow" });
	});

	it("applies pruning savings before threshold comparison", () => {
		const currentModel = model("small", 1_000);
		const message = assistantMessage(currentModel);

		expect(
			decideContextPressure({
				assistantMessage: message,
				currentModel,
				compactionSettings: compactionSettings(),
				skipAbortedCheck: true,
				errorIsFromBeforeCompaction: false,
			}),
		).toEqual({
			kind: "promote-or-compact",
			reason: "threshold",
			willRetry: false,
			compactIfPromotionUnavailable: true,
			contextTokens: 850,
		});

		expect(
			decideContextPressure({
				assistantMessage: message,
				currentModel,
				compactionSettings: compactionSettings(),
				skipAbortedCheck: true,
				errorIsFromBeforeCompaction: false,
				pruneResult: { prunedCount: 1, tokensSaved: 100 },
			}),
		).toEqual({ kind: "skip", reason: "within-threshold", contextTokens: 750 });
	});

	it("skips non-overflow errors and user-aborted messages during post-turn checks", () => {
		const currentModel = model("small", 1_000);

		expect(
			decideContextPressure({
				assistantMessage: assistantMessage(currentModel, {
					stopReason: "error",
					errorMessage: "provider returned 500",
				}),
				currentModel,
				compactionSettings: compactionSettings(),
				skipAbortedCheck: true,
				errorIsFromBeforeCompaction: false,
			}),
		).toEqual({ kind: "skip", reason: "non-overflow-error" });

		expect(
			decideContextPressure({
				assistantMessage: assistantMessage(currentModel, { stopReason: "aborted" }),
				currentModel,
				compactionSettings: compactionSettings(),
				skipAbortedCheck: true,
				errorIsFromBeforeCompaction: false,
			}),
		).toEqual({ kind: "skip", reason: "aborted" });
	});

	it("can include aborted messages in the pre-prompt threshold check", () => {
		const currentModel = model("small", 1_000);

		expect(
			decideContextPressure({
				assistantMessage: assistantMessage(currentModel, { stopReason: "aborted" }),
				currentModel,
				compactionSettings: compactionSettings(),
				skipAbortedCheck: false,
				errorIsFromBeforeCompaction: false,
			}),
		).toEqual({
			kind: "promote-or-compact",
			reason: "threshold",
			willRetry: false,
			compactIfPromotionUnavailable: true,
			contextTokens: 850,
		});
	});

	it("orders role models before the largest remaining fallback", () => {
		const current = model("current", 2_000);
		const slow = model("slow", 5_000);
		const largest = model("largest", 10_000);

		const candidates = orderContextPressureModelCandidates({
			availableModels: [largest, current, slow],
			roleModels: [current, slow, current],
		});

		expect(candidates.map(candidate => candidate.id)).toEqual(["current", "slow", "largest"]);
	});

	it("resolves configured promotion targets by provider-qualified or same-provider id", () => {
		const current = model("small", 1_000, { contextPromotionTarget: "other/large" });
		const explicitTarget = model("large", 10_000, { provider: "other" });
		const sameProviderTarget = model("huge", 20_000);

		expect(resolveContextPromotionConfiguredTarget(current, [explicitTarget, sameProviderTarget])).toBe(
			explicitTarget,
		);
		expect(
			resolveContextPromotionConfiguredTarget(model("small", 1_000, { contextPromotionTarget: "huge" }), [
				explicitTarget,
				sameProviderTarget,
			]),
		).toBe(sameProviderTarget);
	});
});
