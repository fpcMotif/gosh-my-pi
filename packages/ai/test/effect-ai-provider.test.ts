import { describe, expect, it } from "bun:test";
import { LanguageModel } from "@oh-my-pi/pi-ai/effect-ai";
import { streamEffectAiOpenAi } from "@oh-my-pi/pi-ai/effect-ai-provider";
import type { AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { Type } from "@sinclair/typebox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Response from "effect/unstable/ai/Response";

const model: Model<"openai-responses"> = {
	id: "gpt-5",
	name: "GPT-5",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
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
		// AssistantMessageEventStream marks the stream done on the first
		// `error` event, so the second error from finish:error is dropped — pi-ai
		// consumers see exactly one terminal event per turn.
		expect(types).toEqual(["start", "error"]);
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

	it("threads context.tools through Toolkit so the LanguageModel sees the tool surface as opts.tools", async () => {
		// LanguageModel.make's streamText callback receives `ProviderOptions`
		// where `tools` is the flattened array of Tool definitions the
		// service derived from the user-supplied Toolkit.
		let observedToolNames: ReadonlyArray<string> | undefined;
		const observingLayer: Layer.Layer<LanguageModel.LanguageModel> = Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({
				streamText: (opts: { readonly tools?: ReadonlyArray<{ readonly name: string }> }) => {
					observedToolNames = opts.tools !== undefined ? opts.tools.map(t => t.name).sort() : [];
					return Stream.fromIterable<Response.StreamPartEncoded>([
						{
							type: "finish",
							reason: "stop",
							usage: {
								inputTokens: { uncached: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: undefined, reasoning: undefined },
							},
							response: undefined,
						},
					]);
				},
				generateText: () => Effect.succeed([]),
			}),
		);

		const contextWithTools: Context = {
			...context,
			tools: [
				{ name: "get_weather", description: "Get weather", parameters: Type.Object({}) },
				{ name: "list_files", description: "List files", parameters: Type.Object({}) },
			],
		};

		const stream = streamEffectAiOpenAi(model, contextWithTools, { languageModelLayer: observingLayer });
		await collect(stream);

		expect(observedToolNames).toEqual(["get_weather", "list_files"]);
	});

	it("omits the toolkit option when context.tools is empty (matches Effect 4's no-tool shape)", async () => {
		let observedToolCount: number | undefined;
		const observingLayer: Layer.Layer<LanguageModel.LanguageModel> = Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({
				streamText: (opts: { readonly tools?: ReadonlyArray<unknown> }) => {
					observedToolCount = opts.tools?.length ?? 0;
					return Stream.fromIterable<Response.StreamPartEncoded>([]);
				},
				generateText: () => Effect.succeed([]),
			}),
		);

		const stream = streamEffectAiOpenAi(model, context, { languageModelLayer: observingLayer });
		await collect(stream);

		expect(observedToolCount).toBe(0);
	});

	it("surfaces a layer-construction failure as an in-band 'error' event", async () => {
		const failingLayer: Layer.Layer<LanguageModel.LanguageModel, Error, never> = Layer.effect(
			LanguageModel.LanguageModel,
			Effect.fail(new Error("upstream provider unreachable")),
		);

		const stream = streamEffectAiOpenAi(model, context, { languageModelLayer: failingLayer });
		const events = await collect(stream);
		const errorEvent = events.find(e => e.type === "error");
		expect(errorEvent?.type).toBe("error");
		if (errorEvent?.type === "error") {
			expect(errorEvent.error.errorMessage).toMatch(/upstream provider unreachable/);
			expect(errorEvent.error.stopReason).toBe("error");
		}
	});

	it("maps a caller AbortSignal to a terminal 'aborted' error event", async () => {
		// streamText never completes — only the caller's AbortSignal can end
		// the turn. The abort must surface as pi-ai's `aborted` reason (parity
		// with streamOpenAIResponses), not a generic `error`.
		const hangingLayer: Layer.Layer<LanguageModel.LanguageModel> = Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({
				streamText: () => Stream.never,
				generateText: () => Effect.succeed([]),
			}),
		);

		const controller = new AbortController();
		const stream = streamEffectAiOpenAi(model, context, {
			languageModelLayer: hangingLayer,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 10);

		const events = await collect(stream);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type === "error") {
			expect(terminal.reason).toBe("aborted");
			expect(terminal.error.stopReason).toBe("aborted");
			expect(terminal.error.errorMessage).toBe("Request was aborted");
		}
	});
});
