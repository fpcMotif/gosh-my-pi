import type { AssistantMessageEventStream } from "./utils/event-stream";
import type {
	Api,
	AssistantMessage,
	Context,
	KnownApi,
	KnownProvider,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	ToolChoice,
} from "./types";
import { streamOpenAICodexResponses, type OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import { streamOpenAICompletions, type OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamOpenAIResponses, type OpenAIResponsesOptions } from "./providers/openai-responses";

const DEFAULT_MAX_TOKENS = 32000;
export const OUTPUT_FALLBACK_BUFFER = 4000;

export const THINKING_BUDGET_MAP: Record<string, number> = {
	low: 1024,
	medium: 4096,
	high: 16384,
	xhigh: 32768,
};

/**
 * Check for API keys in environment variables for a given provider.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: any): string | undefined {
	const envVar = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
	return process.env[envVar];
}

export function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (choice === undefined) return undefined;
	if (typeof choice === "string") {
		return mapStringOpenAiToolChoice(choice);
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

function mapStringOpenAiToolChoice(choice: string): OpenAICompletionsOptions["toolChoice"] {
	if (choice === "any") return "required";
	if (choice === "auto" || choice === "none" || choice === "required") return choice as "auto" | "none" | "required";
	return undefined;
}

/**
 * Simple stream function that only takes model and context.
 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return stream(model, context, options);
}

/**
 * Convenience wrapper that drains `streamSimple()` and resolves to the final
 * `AssistantMessage`. Mirrors the pre-prune signature consumers in
 * `packages/coding-agent` (compaction, commit-pipeline, changelog) still use.
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return await streamSimple(model, context, options).result();
}

/**
 * Higher-level stream function that handles common options and routing.
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	const apiOptions = mapOptionsForApi(model, options, apiKey);

	switch (model.api) {
		case "openai-completions":
			return streamOpenAICompletions(
				model as Model<"openai-completions">,
				context,
				apiOptions as OpenAICompletionsOptions,
			);
		case "openai-responses":
			return streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				apiOptions as OpenAIResponsesOptions,
			);
		case "openai-codex-responses":
			return streamOpenAICodexResponses(
				model as Model<"openai-codex-responses">,
				context,
				apiOptions as OpenAICodexResponsesOptions,
			);
		default:
			throw new Error(`Unsupported API: ${model.api}`);
	}
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const base = getBaseOptions(model, options, apiKey);

	switch (model.api as KnownApi) {
		case "openai-completions":
			return {
				...base,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningEffort: options?.reasoning,
			} as OptionsForApi<TApi>;

		case "openai-responses":
			return {
				...base,
				toolChoice: options?.toolChoice,
			} as OptionsForApi<TApi>;

		case "openai-codex-responses":
			return {
				...base,
				toolChoice: options?.toolChoice,
			} as OptionsForApi<TApi>;

		default:
			return base as OptionsForApi<TApi>;
	}
}

function getBaseOptions(model: Model, options?: SimpleStreamOptions, apiKey?: string) {
	return {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, DEFAULT_MAX_TOKENS),
		signal: options?.signal,
		apiKey: apiKey ?? options?.apiKey,
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		sessionId: options?.sessionId,
		providerSessionState: options?.providerSessionState,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		preferWebsockets: options?.preferWebsockets,
	};
}
