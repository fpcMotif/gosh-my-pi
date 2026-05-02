/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies at startup.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

interface OpenAICodexResponsesProviderModule {
	streamOpenAICodexResponses: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options: OpenAICodexResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

let openAICodexResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-codex-responses">> | undefined;
let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;
let openAIResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-responses">> | undefined;

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
): void {
	void (async () => {
		try {
			for await (const event of source) {
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const message = createLazyLoadErrorMessage(model, error);
			target.push({ type: "error", reason: "error", error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();

		loadModule()
			.then(module => {
				const inner = module.stream(model, context, options);
				forwardStream(outer, inner, model);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadOpenAICodexResponsesProviderModule(): Promise<LazyProviderModule<"openai-codex-responses">> {
	openAICodexResponsesProviderModulePromise ||= import("./openai-codex-responses").then(module => {
		const provider = module as OpenAICodexResponsesProviderModule;
		return { stream: provider.streamOpenAICodexResponses };
	});
	return openAICodexResponsesProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	openAICompletionsProviderModulePromise ||= import("./openai-completions").then(module => {
		const provider = module as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"openai-responses">> {
	openAIResponsesProviderModulePromise ||= import("./openai-responses").then(module => {
		const provider = module as OpenAIResponsesProviderModule;
		return { stream: provider.streamOpenAIResponses };
	});
	return openAIResponsesProviderModulePromise;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
// ---------------------------------------------------------------------------

export const streamOpenAICodexResponses = createLazyStream(loadOpenAICodexResponsesProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
export const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
