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
// Status: text-only happy path + tool definitions + auth resolution +
// caller-signal abort. Structured output, thinking budgets, service tiers,
// and the full retry / fallback ladder remain as feature-parity follow-ups. The accumulator
// already understands every Effect 4 part variant the call site might see,
// so adding feature support only requires extending the prompt builder +
// `OpenAiLanguageModel.layer` config — the stream pipeline below is final.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModelInternal from "effect/unstable/ai/LanguageModel";
import { makeOmpOpenAiLayer, type OmpOpenAiLayerOptions } from "./effect-ai";
import { resolveOpenAiAuth } from "./effect-ai-auth";
import { buildPrompt } from "./effect-ai-prompt-builder";
import { ResponseStreamAccumulator } from "./effect-ai-stream-accumulator";
import { toolkitFromPiAiTools } from "./effect-ai-toolkit-bridge";
import type { Api, Context, Model, OptionsForApi } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";

export interface EffectAiStreamOptions {
	/**
	 * Caller-supplied API key. When absent, falls back to the canonical
	 * `<PROVIDER>_API_KEY` env var via `getEnvApiKey(model.provider)`.
	 */
	readonly apiKey?: string;
	/**
	 * Override the LanguageModel layer entirely. Test seam: pass a
	 * `Layer.succeed(LanguageModel.LanguageModel, fakeService)` to bypass
	 * `makeOmpOpenAiLayer` (and the OpenAi HTTP wiring it builds).
	 */
	readonly languageModelLayer?: Layer.Layer<LanguageModelInternal.LanguageModel, unknown, never>;
	/**
	 * Override the `makeOmpOpenAiLayer` options. Ignored when
	 * `languageModelLayer` is set. Caller overrides win over the
	 * model-registry defaults (`baseUrl` from `model.baseUrl`).
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
 * The Effect program is forked at the `runPromiseExit` boundary; its parts
 * are pushed to the returned stream as they arrive. The terminal Exit
 * decides the final event: a clean finish ends the stream, a failure or
 * defect emits an in-band `error` event, and a caller-signal abort (via
 * `options.signal`) emits one with `reason: "aborted"`.
 */
export const streamEffectAiOpenAi = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi> & EffectAiStreamOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	const auth = resolveOpenAiAuth(model, {
		apiKey: options?.layerOptions?.apiKey ?? options?.apiKey,
		baseUrl: options?.layerOptions?.baseUrl,
		organizationId: options?.layerOptions?.organizationId,
		projectId: options?.layerOptions?.projectId,
	});

	const layer =
		options?.languageModelLayer ??
		makeOmpOpenAiLayer({
			model: model.id,
			apiKey: auth.apiKey,
			baseUrl: auth.baseUrl,
			organizationId: auth.organizationId,
			projectId: auth.projectId,
			httpClient: options?.layerOptions?.httpClient,
		});

	const accumulator = new ResponseStreamAccumulator({
		api: model.api,
		provider: model.provider,
		model: model.id,
	});

	const prompt = buildPrompt(context);
	const toolkit = toolkitFromPiAiTools(context.tools);

	const program = Effect.gen(function* () {
		const lm = yield* LanguageModelInternal.LanguageModel;
		const partStream = toolkit === undefined ? lm.streamText({ prompt }) : lm.streamText({ prompt, toolkit });
		yield* Stream.runForEach(partStream, part =>
			Effect.sync(() => {
				for (const event of accumulator.feed(part)) {
					stream.push(event);
				}
			}),
		);
	}).pipe(Effect.provide(layer));

	// Pre-attach a no-op result-promise catch: AssistantMessageEventStream's
	// `error()` rejects an internal #resultPromise that nobody awaits in the
	// caller's for-await loop. Without this attachment the rejection surfaces
	// as an unhandled-promise crash in Bun.
	stream.result().catch(() => undefined);

	// runPromiseExit is the runtime boundary: it forks the fiber, wires the
	// caller's AbortSignal to fiber interruption, and observes the terminal
	// Exit — so a defect lands in the Exit's Cause rather than leaking to
	// stderr (no explicit catchDefect needed). The Exit branch decides the
	// in-band terminal event the for-await consumer sees, matching pi-ai's
	// existing providers.
	void Effect.runPromiseExit(program, { signal: options?.signal }).then(exit => {
		if (Exit.isFailure(exit)) {
			// A caller-signal abort surfaces as an interrupt-only Cause; map it
			// to pi-ai's `aborted` reason for parity with streamOpenAIResponses.
			// Trust `hasInterruptsOnly` — a real failure racing with the signal
			// produces a mixed Cause and stays labeled as `error`.
			const aborted = Cause.hasInterruptsOnly(exit.cause);
			const reason = aborted ? "aborted" : "error";
			const squashed = Cause.squash(exit.cause);
			// Push an explicit terminal event so the for-await consumer sees it
			// in-band; AssistantMessageEventStream marks done on this event.
			stream.push({
				type: "error",
				reason,
				error: {
					...accumulator.partial,
					stopReason: reason,
					errorMessage: aborted
						? "Request was aborted"
						: squashed instanceof Error
							? squashed.message
							: String(squashed),
				},
			});
			stream.error(squashed);
			return;
		}
		if (!stream.done) {
			stream.end(accumulator.partial);
		}
	});

	return stream;
};
