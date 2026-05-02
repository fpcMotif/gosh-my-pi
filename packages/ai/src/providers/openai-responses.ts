import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/chat/completions";
import { getEnvApiKey } from "../stream";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type StreamFunction,
	type StreamOptions,
	shouldSendServiceTier,
	type Tool,
	type ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { adaptSchemaForStrict, NO_STRICT } from "../utils/schema";
import { mapToOpenAIResponsesToolChoice, type OpenAIResponsesToolChoice } from "../utils/tool-choice";
import { compactGrammarDefinition } from "./grammar";
import {
	convertMessages,
	processResponsesStream,
} from "./openai-responses-shared";

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	toolChoice?: ToolChoice;
	strictResponsesPairing?: boolean;
}

const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";

interface OpenAIResponsesProviderSessionState extends ProviderSessionState {
	nativeHistoryReplayWarmed: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const state: OpenAIResponsesProviderSessionState = {
		nativeHistoryReplayWarmed: false,
		close: () => {
			state.nativeHistoryReplayWarmed = false;
		},
	};
	return state;
}

function getOpenAIResponsesProviderSessionStateKey(model: Model<"openai-responses">): string {
	return `${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`;
}

function getOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAIResponsesProviderSessionState | undefined {
	if (providerSessionState === undefined || providerSessionState === null) return undefined;
	const key = getOpenAIResponsesProviderSessionStateKey(model);
	const existing = providerSessionState.get(key) as OpenAIResponsesProviderSessionState | undefined;
	if (existing !== undefined && existing !== null) return existing;
	const created = createOpenAIResponsesProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function canReplayOpenAIResponsesNativeHistory(
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): boolean {
	return providerSessionState?.nativeHistoryReplayWarmed ?? true;
}

type OpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	void (async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses" as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const { client, baseUrl } = await createClient(model, apiKey, options?.headers, options?.sessionId);
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const { params } = buildParams(model, context, options, providerSessionState);
			const idleTimeoutMs = getOpenAIStreamIdleTimeoutMs();
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl ?? "https://api.openai.com/v1"}/responses`,
				headers: {}, // Placeholder
				body: params,
			};

			const { data, response, request_id } = await client.chat.completions
				.create(params as any, { signal: requestSignal })
				.withResponse();
			await notifyProviderResponse(options, response, model, request_id);
			const openaiStream = data;

			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			await processResponsesStream(
				iterateWithIdleTimeout(openaiStream as any, {
					idleTimeoutMs,
					watchdog: firstEventWatchdog,
					errorMessage: "OpenAI responses stream stalled while waiting for the next event",
					onIdle: () => requestAbortController.abort(),
				}),
				output,
				stream,
				model,
				{
					onFirstToken: () => {
						if (firstTokenTime === null || firstTokenTime === undefined || firstTokenTime === 0)
							firstTokenTime = Date.now();
					},
					onOutputItemDone: item => {
						nativeOutputItems.push(structuredCloneJSON<unknown>(item) as unknown as Record<string, unknown>);
					},
				},
			);

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeOutputItems);
			if (providerSessionState !== undefined && providerSessionState !== null)
				providerSessionState.nativeHistoryReplayWarmed = true;

			output.duration = Date.now() - startTime;
			if (firstTokenTime !== null && firstTokenTime !== undefined && firstTokenTime > 0)
				output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
			}
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.duration = Date.now() - startTime;
			if (firstTokenTime !== null && firstTokenTime !== undefined && firstTokenTime > 0)
				output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason as "error" | "aborted", error: output });
			stream.end();
		}
	})();

	return stream;
};

async function createClient(
	model: Model<"openai-responses">,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	sessionId?: string,
): Promise<{
	client: OpenAI;
	baseUrl: string | undefined;
}> {
	const effectiveApiKey = apiKey || process.env.OPENAI_API_KEY;
	if (!effectiveApiKey) {
		throw new Error("OpenAI API key is required.");
	}

	const headers: Record<string, string> = { ...model.headers, ...extraHeaders };
	const baseUrl = model.baseUrl;
	if (
		sessionId !== null &&
		sessionId !== undefined &&
		sessionId !== "" &&
		model.provider === "openai" &&
		(baseUrl ?? "").toLowerCase().includes("api.openai.com")
	) {
		headers.session_id = headers.session_id ?? sessionId;
		headers["x-client-request-id"] = headers["x-client-request-id"] ?? sessionId;
	}
	return {
		client: new OpenAI({
			apiKey: effectiveApiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: 5,
			defaultHeaders: headers,
		}),
		baseUrl,
	};
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): { conversationMessages: ResponseInput; params: OpenAIResponsesSamplingParams } {
	const strictResponsesPairing = options?.strictResponsesPairing ?? false;
	const conversationMessages = convertMessages(model, context, strictResponsesPairing, providerSessionState);
	const messages: ResponseInput = [...conversationMessages];

	if (context.systemPrompt !== null && context.systemPrompt !== undefined && context.systemPrompt !== "") {
		messages.unshift({
			role: "system",
			content: context.systemPrompt.toWellFormed(),
		});
	}

	const params: OpenAIResponsesSamplingParams = {
		model: model.id,
		input: messages as any,
		stream: true,
		store: false,
	};

	if (options?.maxTokens !== null && options?.maxTokens !== undefined && options?.maxTokens !== 0) {
		params.max_output_tokens = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.presencePenalty !== undefined) {
		params.presence_penalty = options.presencePenalty;
	}
	if (shouldSendServiceTier(options?.serviceTier, model.provider)) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools, true, model) as any;
		if (options !== undefined && options.toolChoice !== undefined && options.toolChoice !== null) {
			params.tool_choice = mapOpenAIResponsesToolChoiceForTools(options.toolChoice, context.tools, model) as any;
		}
		if (params.tools?.some(t => (t as { type?: string }).type === "custom")) {
			params.parallel_tool_calls = false;
		}
	}

	if (model.reasoning) {
		params.include = ["reasoning.encrypted_content"] as any;

		if (options?.reasoning || options?.reasoningSummary) {
			params.reasoning = {
				effort: options?.reasoning || "medium",
				summary: options?.reasoningSummary || "auto",
			} as any;
		}
	}

	return { conversationMessages, params };
}

export function supportsFreeformApplyPatch(model: Model<"openai-responses">): boolean {
	return model.applyPatchToolType === "freeform";
}

export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	const mapped = mapToOpenAIResponsesToolChoice(choice);
	if (
		mapped === undefined ||
		mapped === null ||
		typeof mapped === "string" ||
		mapped.type !== "function" ||
		supportsFreeformApplyPatch(model) === false
	) {
		return mapped;
	}

	const customTool = tools.find(
		tool =>
			tool.customFormat !== undefined &&
			tool.customFormat !== null &&
			(tool.name === (mapped as { name: string }).name || tool.customWireName === (mapped as { name: string }).name),
	);
	return customTool !== undefined && customTool !== null
		? { type: "custom", name: customTool.customWireName ?? customTool.name }
		: mapped;
}

export function convertTools(tools: Tool[], strictMode: boolean, model: Model<"openai-responses">): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	return tools.map(tool => {
		if (allowFreeform && tool.customFormat !== undefined && tool.customFormat !== null) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			} as unknown as OpenAITool;
		}
		const strict = NO_STRICT === false && strictMode && tool.strict !== false;
		const baseParameters = tool.parameters as unknown as Record<string, unknown>;
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		} as OpenAITool;
	});
}
