import { describe, expect, it } from "bun:test";
import { LanguageModel } from "@oh-my-pi/pi-ai/effect-ai";
import { streamEffectAiOpenAi } from "@oh-my-pi/pi-ai/effect-ai-provider";
import type { AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Response from "effect/unstable/ai/Response";

const model: Model<"openai-responses"> = {
	id: "gpt-5",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://example.test/v1",
	contextLength: 200_000,
	maxOutputTokens: 16_384,
};

const context: Context = {
	systemPrompt: "be brief",
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const stubLayerFromParts = (
	parts: ReadonlyArray<Response.StreamPartEncoded>,
): Layer.Layer<LanguageModel.LanguageModel> =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({
			streamText: () => Stream.fromIterable(parts),
			generateText: () => Effect.succeed([]),
		}),
	);

const collect = async (stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> => {
	const out: AssistantMessageEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
};

describe("streamEffectAiOpenAi — pi-ai-compatible streaming via Effect 4 LanguageModel", () => {
	it("emits start + text events + done for a simple text-only turn", async () => {
		const parts: ReadonlyArray<Response.StreamPartEncoded> = [
			{ type: "text-start", id: "1" },
			{ type: "text-delta", id: "1", delta: "Hi" },
			{ type: "text-delta", id: "1", delta: " there" },
			{ type: "text-end", id: "1" },
			{
				type: "finish",
				reason: "stop",
				usage: {
					inputTokens: { uncached: 5, total: 5, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 2, text: 2, reasoning: undefined },
				},
				response: undefined,
			},
		];

		const stream = streamEffectAiOpenAi(model, context, {
			languageModelLayer: stubLayerFromParts(parts),
		});

		const events = await collect(stream);
		const types = events.map(e => e.type);

		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		const done = events.find(e => e.type === "done");
		if (done?.type === "done") {
			expect(done.reason).toBe("stop");
			expect(done.message.content).toEqual([{ type: "text", text: "Hi there" }]);
		}
	});

	it("propagates a finish:error part as a pi-ai 'error' event, not 'done'", async () => {
		const parts: ReadonlyArray<Response.StreamPartEncoded> = [
			{ type: "error", error: "rate limit" },
			{
				type: "finish",
				reason: "error",
				usage: {
					inputTokens: { uncached: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 0, text: undefined, reasoning: undefined },
				},
				response: undefined,
			},
		];

		const stream = streamEffectAiOpenAi(model, context, {
			languageModelLayer: stubLayerFromParts(parts),
		});

		const events = await collect(stream);
		const types = events.map(e => e.type);
		expect(types).toEqual(["start", "error", "error"]);
	});

	it("ends cleanly when the stream completes without a finish part", async () => {
		const parts: ReadonlyArray<Response.StreamPartEncoded> = [
			{ type: "text-start", id: "1" },
			{ type: "text-delta", id: "1", delta: "partial" },
			{ type: "text-end", id: "1" },
		];

		const stream = streamEffectAiOpenAi(model, context, {
			languageModelLayer: stubLayerFromParts(parts),
		});

		const events = await collect(stream);
		expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_end"]);
	});

	it("threads tool params end-to-end (params start -> delta -> finish reason 'toolUse')", async () => {
		// `tool-call` parts are finalised by LanguageModel.streamText internally
		// based on the toolkit definition — provider streamText only emits
		// `tool-params-*`. The toolcall_end pi-ai event therefore lands at slice
		// 4 (toolkit construction); this test verifies the pre-finalisation
		// transport works.
		const parts: ReadonlyArray<Response.StreamPartEncoded> = [
			{ type: "tool-params-start", id: "tc_1", name: "get_weather", providerExecuted: false },
			{ type: "tool-params-delta", id: "tc_1", delta: '{"city":"NYC"}' },
			{ type: "tool-params-end", id: "tc_1" },
			{
				type: "finish",
				reason: "tool-calls",
				usage: {
					inputTokens: { uncached: 10, total: 10, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 5, text: undefined, reasoning: undefined },
				},
				response: undefined,
			},
		];

		const stream = streamEffectAiOpenAi(model, context, {
			languageModelLayer: stubLayerFromParts(parts),
		});

		const events = await collect(stream);
		const types = events.map(e => e.type);
		expect(types).toEqual(["start", "toolcall_start", "toolcall_delta", "done"]);

		const done = events.find(e => e.type === "done");
		if (done?.type === "done") expect(done.reason).toBe("toolUse");
	});

	it("surfaces a layer-construction failure via the stream's error channel", async () => {
		const failingLayer: Layer.Layer<LanguageModel.LanguageModel> = Layer.effect(
			LanguageModel.LanguageModel,
			Effect.die("upstream provider unreachable"),
		);

		const stream = streamEffectAiOpenAi(model, context, { languageModelLayer: failingLayer });
		await expect(collect(stream)).rejects.toBeDefined();
	});
});
