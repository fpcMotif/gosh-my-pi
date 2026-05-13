import { describe, expect, it } from "bun:test";
import { LanguageModel, makeOmpOpenAiLayer } from "@oh-my-pi/pi-ai/effect-ai";
import { Effect } from "effect";

describe("@oh-my-pi/pi-ai/effect-ai — Effect 4 LanguageModel bridge", () => {
	it("makeOmpOpenAiLayer resolves LanguageModel.LanguageModel with the v4 ai/openai surface", async () => {
		const layer = makeOmpOpenAiLayer({ model: "gpt-5", apiKey: "fake-key-for-layer-resolution" });

		const probe = Effect.gen(function* () {
			const m = yield* LanguageModel.LanguageModel;
			return {
				generateText: typeof m.generateText,
				streamText: typeof m.streamText,
				generateObject: typeof m.generateObject,
			};
		});

		const result = await Effect.runPromise(Effect.provide(probe, layer));

		expect(result.generateText).toBe("function");
		expect(result.streamText).toBe("function");
		expect(result.generateObject).toBe("function");
	});

	it("threads baseUrl override into the layer construction", async () => {
		const layer = makeOmpOpenAiLayer({
			model: "gpt-5",
			apiKey: "fake",
			baseUrl: "https://example.test/v1",
		});

		// We can't directly observe the apiUrl without making a request; the
		// contract this test defends is that constructing the layer with the
		// override does not throw and still resolves LanguageModel cleanly.
		const probe = Effect.gen(function* () {
			const m = yield* LanguageModel.LanguageModel;
			return m !== undefined;
		});

		const result = await Effect.runPromise(Effect.provide(probe, layer));
		expect(result).toBe(true);
	});

	it("allows omitting apiKey at layer-build time (caller fails when actually used, not at construction)", async () => {
		const layer = makeOmpOpenAiLayer({ model: "gpt-5" });

		const probe = Effect.gen(function* () {
			const m = yield* LanguageModel.LanguageModel;
			return typeof m;
		});

		const result = await Effect.runPromise(Effect.provide(probe, layer));
		expect(result).toBe("object");
	});
});
