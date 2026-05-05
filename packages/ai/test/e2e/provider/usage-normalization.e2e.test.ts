import { describe, expect, it } from "bun:test";
import { calculateCost } from "@oh-my-pi/pi-ai";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { parseChunkUsage } from "@oh-my-pi/pi-ai/providers/openai-completions";

/**
 * Contract: usage parsing and cost calculation are the boundary between raw
 * provider chunk data and the rest of the agent runtime. They must:
 *   1. Default missing fields to 0 (no NaN, no undefined leaking).
 *   2. Clamp `input` to non-negative (prompt - cached - cacheWrite can be
 *      negative if cached > prompt - already done in parseChunkUsage).
 *   3. Sum components into totalTokens consistently.
 *   4. Multiply by per-token cost in millionths and produce a `cost.total`
 *      that matches the sum of cost components.
 */

function makeModel(): Model<"openai-completions"> {
	return {
		id: "test",
		name: "test",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		// Per-million-token rates
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("provider usage parsing — parseChunkUsage", () => {
	it("returns all-zero usage when raw object is empty", () => {
		const usage = parseChunkUsage({}, makeModel());
		expect(usage.input).toBe(0);
		expect(usage.output).toBe(0);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(0);
	});

	it("populates output (completion_tokens) when present", () => {
		const usage = parseChunkUsage({ completion_tokens: 50 }, makeModel());
		expect(usage.output).toBe(50);
		expect(usage.totalTokens).toBe(50);
	});

	it("clamps prompt - cached - cacheWrite to a non-negative input count", () => {
		// If the provider reports a small prompt with a larger cached count
		// (e.g., due to caching ambiguity), input must not go negative.
		const usage = parseChunkUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } }, makeModel());
		expect(usage.input).toBeGreaterThanOrEqual(0);
		expect(usage.cacheRead).toBe(100);
	});

	it("computes totalTokens as the sum of input + output + cacheRead + cacheWrite", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 200,
				completion_tokens: 50,
				prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
			},
			makeModel(),
		);
		// input = 200 - 30 - 20 = 150; total = 150 + 50 + 30 + 20 = 250
		expect(usage.input).toBe(150);
		expect(usage.cacheRead).toBe(30);
		expect(usage.cacheWrite).toBe(20);
		expect(usage.output).toBe(50);
		expect(usage.totalTokens).toBe(250);
	});

	it("attaches a reasoningTokens field when completion_tokens_details has nonzero reasoning_tokens", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 10,
				completion_tokens: 50,
				completion_tokens_details: { reasoning_tokens: 12 },
			},
			makeModel(),
		);
		expect(usage.reasoningTokens).toBe(12);
	});

	it("omits the reasoningTokens field when reasoning_tokens is zero or absent", () => {
		const a = parseChunkUsage({ prompt_tokens: 10, completion_tokens: 5 }, makeModel());
		expect(a.reasoningTokens).toBeUndefined();

		const b = parseChunkUsage(
			{ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } },
			makeModel(),
		);
		expect(b.reasoningTokens).toBeUndefined();
	});

	it("populates a finite cost.total derived from per-token cost components", () => {
		const usage = parseChunkUsage({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }, makeModel());
		// input cost = (1/1_000_000) * 1_000_000 = 1.0
		// output cost = (2/1_000_000) * 500_000 = 1.0
		// total = 2.0 (no cache)
		expect(Number.isFinite(usage.cost.total)).toBe(true);
		expect(usage.cost.total).toBeCloseTo(2.0, 6);
		expect(usage.cost.input).toBeCloseTo(1.0, 6);
		expect(usage.cost.output).toBeCloseTo(1.0, 6);
	});

	it("ignores fields whose type is not number", () => {
		const usage = parseChunkUsage(
			{ prompt_tokens: "200", completion_tokens: null, prompt_tokens_details: { cached_tokens: undefined } },
			makeModel(),
		);
		// All non-numeric fields default to 0
		expect(usage.input).toBe(0);
		expect(usage.output).toBe(0);
		expect(usage.cacheRead).toBe(0);
	});
});

describe("calculateCost — invariants", () => {
	it("computes cost.total as the sum of cost components", () => {
		const model = makeModel();
		const usage = emptyUsage();
		usage.input = 1_000_000;
		usage.output = 500_000;
		usage.cacheRead = 200_000;
		usage.cacheWrite = 100_000;

		calculateCost(model, usage);

		const computedTotal = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
		expect(usage.cost.total).toBeCloseTo(computedTotal, 9);
	});

	it("returns the same cost object that's mutated on the input usage", () => {
		const model = makeModel();
		const usage = emptyUsage();
		const result = calculateCost(model, usage);
		expect(result).toBe(usage.cost);
	});

	it("produces zero cost when all token counts are zero", () => {
		const model = makeModel();
		const usage = emptyUsage();
		calculateCost(model, usage);
		expect(usage.cost.input).toBe(0);
		expect(usage.cost.output).toBe(0);
		expect(usage.cost.cacheRead).toBe(0);
		expect(usage.cost.cacheWrite).toBe(0);
		expect(usage.cost.total).toBe(0);
	});

	it("scales linearly: doubling tokens doubles cost", () => {
		const model = makeModel();
		const a = emptyUsage();
		a.input = 1000;
		a.output = 500;
		calculateCost(model, a);

		const b = emptyUsage();
		b.input = 2000;
		b.output = 1000;
		calculateCost(model, b);

		expect(b.cost.input).toBeCloseTo(a.cost.input * 2, 9);
		expect(b.cost.output).toBeCloseTo(a.cost.output * 2, 9);
		expect(b.cost.total).toBeCloseTo(a.cost.total * 2, 9);
	});
});
