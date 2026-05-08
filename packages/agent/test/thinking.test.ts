import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai/model-thinking";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, test } from "bun:test";
import { parseThinkingLevel, resolveThinkingLevelForModel, ThinkingLevel, toReasoningEffort } from "../src/thinking";

function reasoningModel(thinkingMin: Effort, thinkingMax: Effort): Model {
	return fromAny<Model>({
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinking: { mode: "effort", minLevel: thinkingMin, maxLevel: thinkingMax },
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
}

function nonReasoningModel(): Model {
	return fromAny<Model>({
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
}

describe("parseThinkingLevel", () => {
	test("recognizes 'inherit' and 'off'", () => {
		expect(parseThinkingLevel("inherit")).toBe(ThinkingLevel.Inherit);
		expect(parseThinkingLevel("off")).toBe(ThinkingLevel.Off);
	});

	test("recognizes all Effort values", () => {
		expect(parseThinkingLevel("minimal")).toBe(ThinkingLevel.Minimal);
		expect(parseThinkingLevel("low")).toBe(ThinkingLevel.Low);
		expect(parseThinkingLevel("medium")).toBe(ThinkingLevel.Medium);
		expect(parseThinkingLevel("high")).toBe(ThinkingLevel.High);
		expect(parseThinkingLevel("xhigh")).toBe(ThinkingLevel.XHigh);
	});

	test("returns undefined for unknown / null / empty", () => {
		expect(parseThinkingLevel("nonsense")).toBeUndefined();
		expect(parseThinkingLevel(null)).toBeUndefined();
		expect(parseThinkingLevel(undefined)).toBeUndefined();
		expect(parseThinkingLevel("")).toBeUndefined();
	});
});

describe("toReasoningEffort", () => {
	test("returns undefined for off / inherit / undefined", () => {
		expect(toReasoningEffort(ThinkingLevel.Off)).toBeUndefined();
		expect(toReasoningEffort(ThinkingLevel.Inherit)).toBeUndefined();
		expect(toReasoningEffort(undefined)).toBeUndefined();
	});

	test("passes through Effort values", () => {
		expect(toReasoningEffort(ThinkingLevel.Minimal)).toBe(Effort.Minimal);
		expect(toReasoningEffort(ThinkingLevel.Low)).toBe(Effort.Low);
		expect(toReasoningEffort(ThinkingLevel.High)).toBe(Effort.High);
	});
});

describe("resolveThinkingLevelForModel", () => {
	test("'inherit' → undefined", () => {
		expect(
			resolveThinkingLevelForModel(reasoningModel(Effort.Low, Effort.High), ThinkingLevel.Inherit),
		).toBeUndefined();
	});

	test("undefined input → undefined", () => {
		expect(resolveThinkingLevelForModel(reasoningModel(Effort.Low, Effort.High), undefined)).toBeUndefined();
	});

	test("'off' is preserved as 'off'", () => {
		expect(resolveThinkingLevelForModel(reasoningModel(Effort.Low, Effort.High), ThinkingLevel.Off)).toBe(
			ThinkingLevel.Off,
		);
	});

	test("Effort within model's supported range passes through", () => {
		expect(resolveThinkingLevelForModel(reasoningModel(Effort.Low, Effort.High), ThinkingLevel.Medium)).toBe(
			Effort.Medium,
		);
	});

	test("Effort above max gets clamped down", () => {
		expect(resolveThinkingLevelForModel(reasoningModel(Effort.Low, Effort.Medium), ThinkingLevel.XHigh)).toBe(
			Effort.Medium,
		);
	});

	test("non-reasoning model returns undefined for any Effort", () => {
		expect(resolveThinkingLevelForModel(nonReasoningModel(), ThinkingLevel.Medium)).toBeUndefined();
	});

	test("undefined model passes Effort through unchanged (no clamp data)", () => {
		expect(resolveThinkingLevelForModel(undefined, ThinkingLevel.High)).toBe(Effort.High);
	});
});
