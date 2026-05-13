// Effect-native AI surface for the workspace.
//
// Re-exports the Effect 4 AI primitives (LanguageModel, Prompt, Response, Tool,
// Toolkit, AiError) from `effect/unstable/ai/*` and the OpenAI provider from
// `@effect/ai-openai`, so consumers can import the typed surface from a single
// workspace-pinned entry point rather than reaching into the upstream module
// graph directly. Mirrors the policy in `packages/utils/src/effect.ts` for the
// core Effect modules.
//
// Status: the existing pi-ai providers (streamOpenAIResponses /
// streamOpenAICompletions / streamOpenAICodexResponses) remain the production
// streaming path, all routing through `Http.requestStream` (ADR-0005).
// `makeOmpOpenAiLayer` is the entry point for *new* call sites that prefer
// Effect.gen + LanguageModel.Service over the existing AsyncIterable surface.
// The full call-site migration (StreamFunction → LanguageModel.streamText) is
// staged for a follow-up PR — see docs/plans/p4d-http-stream-watchdog.md §
// "Out of scope" for the trajectory.

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as LanguageModelInternal from "effect/unstable/ai/LanguageModel";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";

export { OpenAiClient, OpenAiLanguageModel };
export * as AiError from "effect/unstable/ai/AiError";
export * as LanguageModel from "effect/unstable/ai/LanguageModel";
export * as Prompt from "effect/unstable/ai/Prompt";
export * as Response from "effect/unstable/ai/Response";
export * as Tool from "effect/unstable/ai/Tool";
export * as Toolkit from "effect/unstable/ai/Toolkit";

/**
 * Options for building a self-contained Effect Layer that resolves
 * `LanguageModel.LanguageModel` against an OpenAI-compatible HTTP API.
 *
 * Mirrors the inputs to the existing pi-ai providers (apiKey, baseUrl) but
 * carries them through the Effect 4 ai/openai pipeline instead of through
 * `StreamFunction` + `Http.requestStream`.
 */
export interface OmpOpenAiLayerOptions {
	/** OpenAI-style model id, e.g. `"gpt-5"`, `"o1-preview"`. */
	readonly model: string;
	/** API key. Wrapped in `Redacted` before reaching the wire so it stays out of logs. */
	readonly apiKey?: string;
	/** Override the API base URL. Defaults to `https://api.openai.com/v1`. */
	readonly baseUrl?: string;
	/** Optional organization id (multi-org accounts). */
	readonly organizationId?: string;
	/** Optional project id (project-scoped keys). */
	readonly projectId?: string;
	/**
	 * Override the underlying `HttpClient.HttpClient` layer.
	 *
	 * Defaults to `FetchHttpClient.layer` (which captures the global `fetch`).
	 * Tests pass a stub layer here to intercept the wire without monkey-patching
	 * `globalThis.fetch`.
	 */
	readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
}

/**
 * Build a fully-provided Effect Layer that resolves
 * `LanguageModel.LanguageModel`. Composes three sub-layers:
 *
 *   FetchHttpClient (or caller stub) -> OpenAiClient -> OpenAiLanguageModel
 *
 * Usage:
 *
 *   import { Effect } from "@oh-my-pi/pi-utils/effect";
 *   import { LanguageModel, makeOmpOpenAiLayer } from "@oh-my-pi/pi-ai";
 *
 *   const program = Effect.gen(function* () {
 *       const m = yield* LanguageModel.LanguageModel;
 *       const stream = m.streamText({ prompt: "hello" });
 *       // ...
 *   });
 *
 *   await Effect.runPromise(
 *       program.pipe(Effect.provide(makeOmpOpenAiLayer({ model: "gpt-5", apiKey }))),
 *   );
 */
export function makeOmpOpenAiLayer(options: OmpOpenAiLayerOptions): Layer.Layer<LanguageModelInternal.LanguageModel> {
	const clientLayer = OpenAiClient.layer({
		apiKey: options.apiKey === undefined ? undefined : Redacted.make(options.apiKey),
		apiUrl: options.baseUrl,
		organizationId: options.organizationId === undefined ? undefined : Redacted.make(options.organizationId),
		projectId: options.projectId === undefined ? undefined : Redacted.make(options.projectId),
	});
	const httpLayer = options.httpClient ?? FetchHttpClient.layer;
	const modelLayer = OpenAiLanguageModel.layer({ model: options.model });
	return modelLayer.pipe(Layer.provide(clientLayer), Layer.provide(httpLayer));
}
