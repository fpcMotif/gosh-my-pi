/**
 * Kimi Code provider - wraps OpenAI-compatible API.
 *
 * Endpoint: https://api.kimi.com/coding/v1/chat/completions
 *
 * Note: Kimi calculates TPM rate limits based on max_tokens, not actual output.
 */

import { Effect, Stream } from "@oh-my-pi/pi-utils/effect";
import { runEffectStream } from "../effect-stream";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import { streamOpenAICompletions } from "./openai-completions";
import { createProviderErrorMessage } from "./shared/error-message";

/**
 * Stream from Kimi Code using the OpenAI-compatible endpoint.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const eventStream = new AssistantMessageEventStream();

	const stream: Stream.Stream<AssistantMessageEvent, Error> = Stream.unwrap(
		Effect.gen(function* () {
			const kimiHeaders = yield* Effect.promise(() => getKimiCommonHeaders());
			const innerStream = streamOpenAICompletions(model, context, {
				apiKey: options?.apiKey,
				temperature: options?.temperature,
				topP: options?.topP,
				topK: options?.topK,
				minP: options?.minP,
				presencePenalty: options?.presencePenalty,
				repetitionPenalty: options?.repetitionPenalty,
				maxTokens: options?.maxTokens ?? model.maxTokens,
				signal: options?.signal,
				headers: { ...kimiHeaders, ...options?.headers },
				sessionId: options?.sessionId,
				onPayload: options?.onPayload,
				reasoning: options?.reasoning,
			});
			return Stream.fromAsyncIterable(innerStream, e => (e instanceof Error ? e : new Error(String(e))));
		}),
	).pipe(
		Stream.catch(error =>
			Stream.succeed<AssistantMessageEvent>({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, error),
			}),
		),
	);

	void runEffectStream(stream, eventStream, options);

	return eventStream;
}

/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
