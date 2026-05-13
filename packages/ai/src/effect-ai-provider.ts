// streamEffectAiOpenAi — pi-ai-compatible streaming via the Effect 4
// LanguageModel + OpenAiLanguageModel stack.
//
// Slice 3/4 of the provider rewrite. The previous slices established:
//
//   1. effect-ai.ts            — `makeOmpOpenAiLayer` builds the layer stack
//                                FetchHttpClient -> OpenAiClient -> OpenAiLanguageModel.
//   2. effect-ai-stream-adapter.ts (forward) +
//      effect-ai-stream-accumulator.ts (reverse) — bidirectional mapping
//                                between pi-ai's AssistantMessageEvent stream
//                                and Effect 4's Response.StreamPart stream.
//   3. effect-ai-prompt-builder.ts — pi-ai Context -> Effect 4 Prompt.
//
// This module wires those into a `StreamFunction`-shaped entry point. It is
// drop-in compatible with the existing `streamOpenAIResponses` /
// `streamOpenAICompletions` signature so call sites can migrate
// incrementally without changing their for-await loop or AbortSignal
// plumbing.
//
// Status: text-only happy path. Tools, structured output, thinking budgets,
// service tiers, and the full retry / fallback ladder remain as feature
// parity work for slice 4. The accumulator already understands every
// Effect 4 part variant the call site might see, so adding feature support
// only requires extending the prompt builder + Toolkit construction; the
// stream pipeline below is final.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModelInternal from "effect/unstable/ai/LanguageModel";
import { makeOmpOpenAiLayer, type OmpOpenAiLayerOptions } from "./effect-ai";
import { buildPrompt } from "./effect-ai-prompt-builder";
import { ResponseStreamAccumulator } from "./effect-ai-stream-accumulator";
import type { Api, Context, Model, OptionsForApi } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";

export interface EffectAiStreamOptions {
	/**
	 * Override the LanguageModel layer entirely. Test seam: pass a
	 * `Layer.succeed(LanguageModel.LanguageModel, fakeService)` to bypass
	 * `makeOmpOpenAiLayer` (and the OpenAi HTTP wiring it builds).
	 */
	readonly languageModelLayer?: Layer.Layer<LanguageModelInternal.LanguageModel>;
	/**
	 * Override the `makeOmpOpenAiLayer` options. Ignored when
	 * `languageModelLayer` is set. Defaults: model from
	 * `model.id`; apiKey + baseUrl are caller-supplied (no env fallback
	 * here — slice 4 will wire pi-ai's auth resolvers).
	 */
	readonly layerOptions?: Partial<OmpOpenAiLayerOptions>;
}

/**
 * Stream an OpenAI-shaped turn through the Effect 4 LanguageModel stack
 * while preserving pi-ai's `AssistantMessageEventStream` consumer contract.
 *
 * Call sites that already consume `streamOpenAIResponses(model, context,
 * options)` can swap to this function without touching their for-await
 * loops; the resulting stream emits the same `AssistantMessageEvent`
 * variants in the same order.
 *
 * The Effect program is spawned in a fire-and-forget IIFE that pushes
 * events to the returned stream as parts arrive. Errors from
 * `Effect.runPromise` are reported via `stream.error(...)`, which surfaces
 * to the consumer's iterator as a rejection.
 */
export const streamEffectAiOpenAi = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi> & EffectAiStreamOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	const layer =
		options?.languageModelLayer ??
		makeOmpOpenAiLayer({
			model: model.id,
			apiKey: options?.layerOptions?.apiKey,
			baseUrl: options?.layerOptions?.baseUrl,
			organizationId: options?.layerOptions?.organizationId,
			projectId: options?.layerOptions?.projectId,
			httpClient: options?.layerOptions?.httpClient,
		});

	const accumulator = new ResponseStreamAccumulator({
		api: model.api,
		provider: model.provider,
		model: model.id,
	});

	const prompt = buildPrompt(context);

	const program = Effect.gen(function* () {
		const lm = yield* LanguageModelInternal.LanguageModel;
		const partStream = lm.streamText({ prompt });
		yield* Stream.runForEach(partStream, part =>
			Effect.sync(() => {
				for (const event of accumulator.feed(part)) {
					stream.push(event);
				}
			}),
		);
	});

	// runPromiseExit (not runPromise) so Effect's defect reporter doesn't
	// log fiber defects to stderr in parallel with our caller seeing the
	// rejection — a single failure path keeps the consumer's catch clean.
	void (async () => {
		const exit = await Effect.runPromiseExit(Effect.provide(program, layer));
		if (Exit.isFailure(exit)) {
			stream.error(Cause.squash(exit.cause));
			return;
		}
		if (!stream.done) {
			stream.end(accumulator.partial);
		}
	})();

	return stream;
};
