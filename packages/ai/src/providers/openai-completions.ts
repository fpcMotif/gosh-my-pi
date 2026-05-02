import { $env } from "@oh-my-pi/pi-utils";
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import {
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type StopReason,
	type StreamFunction,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolChoice,
	type ToolResultMessage,
} from "../types";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { type CapturedHttpErrorResponse, finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseStreamingJson } from "../utils/json-parse";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import { notifyProviderResponse } from "../utils/provider-response";
import { extractHttpStatusFromError } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT } from "../utils/schema";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import { detectOpenAICompat, type ResolvedOpenAICompat, resolveOpenAICompat } from "./openai-completions-compat";
import { transformMessages } from "./transform-messages";

/**
 * Normalize tool call ID for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	// Remove non-alphanumeric characters
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// Mistral requires exactly 9 characters
	if (normalized.length < 9) {
		// Pad with deterministic characters based on original ID to ensure matching
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}

function serializeToolArguments(value: unknown): string {
	if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(parsed);
			}
		} catch {}
		return "{}";
	}

	return "{}";
}

/**
 * Check if conversation messages contain tool calls or tool results.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	serviceTier?: ServiceTier;
}

type OpenAICompletionsSamplingParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
};

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

type OpenAICompletionsProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
};

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const state: OpenAICompletionsProviderSessionState = {
		strictToolsDisabled: false,
		close: () => {
			state.strictToolsDisabled = false;
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

// LIMITATION: The think tag parser uses naive string matching for <think>/<thinking> tags.
const MINIMAX_THINK_OPEN_TAGS = ["<think>", "<thinking>"] as const;
const MINIMAX_THINK_CLOSE_TAGS = ["</think>", "</thinking>"] as const;

function findFirstTag(text: string, tags: readonly string[]): { index: number; tag: string } | undefined {
	let earliestIndex = Number.POSITIVE_INFINITY;
	let earliestTag: string | undefined;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index !== -1 && index < earliestIndex) {
			earliestIndex = index;
			earliestTag = tag;
		}
	}
	if (earliestTag === null || earliestTag === undefined || earliestTag === "") return undefined;
	return { index: earliestIndex, tag: earliestTag };
}

function getTrailingPartialTag(text: string, tags: readonly string[]): string {
	let maxLength = 0;
	for (const tag of tags) {
		const maxCandidateLength = Math.min(tag.length - 1, text.length);
		for (let length = maxCandidateLength; length > 0; length--) {
			if (text.endsWith(tag.slice(0, length))) {
				if (length > maxLength) maxLength = length;
				break;
			}
		}
	}
	if (maxLength === 0) return "";
	return text.slice(-maxLength);
}

const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		let getCapturedErrorResponse: (() => CapturedHttpErrorResponse | undefined) | undefined;

		const output: AssistantMessage = {
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const idleTimeoutMs = getOpenAIStreamIdleTimeoutMs();
			const {
				client,
				baseUrl,
				requestHeaders,
				getCapturedErrorResponse: captureErrorResponse,
				clearCapturedErrorResponse,
			} = await createClient(model, context, apiKey, options?.headers);
			getCapturedErrorResponse = captureErrorResponse;
			let appliedToolStrictMode: AppliedToolStrictMode = "mixed";
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			const disableStrictTools = providerSessionState?.strictToolsDisabled ?? false;

			const createCompletionsStream = async (toolStrictModeOverride?: ToolStrictModeOverride) => {
				clearCapturedErrorResponse();
				const effectiveToolStrictModeOverride = disableStrictTools ? "none" : toolStrictModeOverride;
				const { params, toolStrictMode } = buildParams(
					model,
					context,
					options,
					baseUrl,
					effectiveToolStrictModeOverride,
				);
				appliedToolStrictMode = toolStrictMode;
				options?.onPayload?.(params);
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/chat/completions`,
					headers: requestHeaders,
					body: params,
				};
				const { data, response, request_id } = await client.chat.completions
					.create(params, { signal: requestSignal })
					.withResponse();
				await notifyProviderResponse(options, response, model, request_id);
				return data;
			};
			let openaiStream: AsyncIterable<ChatCompletionChunk>;
			try {
				openaiStream = await createCompletionsStream();
			} catch (error) {
				const capturedErrorResponse = getCapturedErrorResponse();
				if (!shouldRetryWithoutStrictTools(error, capturedErrorResponse, appliedToolStrictMode, context.tools)) {
					throw error;
				}
				openaiStream = await createCompletionsStream("none");
			}
			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			stream.push({ type: "start", partial: output });

			const parseMiniMaxThinkTags = model.provider === "minimax-code" || model.provider === "minimax";
			type OpenAIStreamBlock = TextContent | ThinkingContent | (ToolCall & { partialArgs: string });
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const finishCurrentBlock = (block: OpenAIStreamBlock | undefined): void => {
				if (!block) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return;
				}
				if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return;
				}
				block.arguments = parseStreamingJson(block.partialArgs);
				delete (block as { partialArgs?: string }).partialArgs;
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (!currentBlock || currentBlock.type !== "text") {
					finishCurrentBlock(currentBlock);
					currentBlock = { type: "text", text: "" };
					message.content.push(currentBlock);
					eventStream.push({ type: "text_start", contentIndex: blockIndex(currentBlock), partial: message });
				}
				currentBlock.text += text;
				eventStream.push({
					type: "text_delta",
					contentIndex: blockIndex(currentBlock),
					delta: text,
					partial: message,
				});
			};
			const appendThinking = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				thinking: string,
				signature?: string,
			): void => {
				if (
					!currentBlock ||
					currentBlock.type !== "thinking" ||
					(signature !== undefined && currentBlock.thinkingSignature !== signature)
				) {
					finishCurrentBlock(currentBlock);
					currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
					message.content.push(currentBlock);
					eventStream.push({
						type: "thinking_start",
						contentIndex: blockIndex(currentBlock),
						partial: message,
					});
				}
				if (
					signature !== undefined &&
					(currentBlock.thinkingSignature === null ||
						currentBlock.thinkingSignature === undefined ||
						currentBlock.thinkingSignature === "")
				) {
					currentBlock.thinkingSignature = signature;
				}
				currentBlock.thinking += thinking;
				eventStream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(currentBlock),
					delta: thinking,
					partial: message,
				});
			};

			let taggedTextBuffer = "";
			let insideTaggedThinking = false;
			const appendTextDelta = (text: string) => {
				if (!text) return;
				if (firstTokenTime === null || firstTokenTime === undefined || firstTokenTime === 0)
					firstTokenTime = Date.now();
				appendText(output, stream, text);
			};
			const appendThinkingDelta = (thinking: string, signature?: string) => {
				if (!thinking) return;
				if (firstTokenTime === null || firstTokenTime === undefined || firstTokenTime === 0)
					firstTokenTime = Date.now();
				appendThinking(output, stream, thinking, signature);
			};

			const flushTaggedTextBuffer = () => {
				while (taggedTextBuffer.length > 0) {
					if (insideTaggedThinking) {
						const closingTag = findFirstTag(taggedTextBuffer, MINIMAX_THINK_CLOSE_TAGS);
						if (closingTag) {
							appendThinkingDelta(taggedTextBuffer.slice(0, closingTag.index));
							taggedTextBuffer = taggedTextBuffer.slice(closingTag.index + closingTag.tag.length);
							insideTaggedThinking = false;
							continue;
						}

						const trailingPartialTag = getTrailingPartialTag(taggedTextBuffer, MINIMAX_THINK_CLOSE_TAGS);
						const flushLength = taggedTextBuffer.length - trailingPartialTag.length;
						appendThinkingDelta(taggedTextBuffer.slice(0, flushLength));
						taggedTextBuffer = trailingPartialTag;
						break;
					}

					const openingTag = findFirstTag(taggedTextBuffer, MINIMAX_THINK_OPEN_TAGS);
					if (openingTag) {
						appendTextDelta(taggedTextBuffer.slice(0, openingTag.index));
						taggedTextBuffer = taggedTextBuffer.slice(openingTag.index + openingTag.tag.length);
						insideTaggedThinking = true;
						continue;
					}

					const trailingPartialTag = getTrailingPartialTag(taggedTextBuffer, MINIMAX_THINK_OPEN_TAGS);
					const flushLength = taggedTextBuffer.length - trailingPartialTag.length;
					appendTextDelta(taggedTextBuffer.slice(0, flushLength));
					taggedTextBuffer = trailingPartialTag;
					break;
				}
			};

			const processChoiceDelta = (delta: ChatCompletionChunk.Choice.Delta): void => {
				if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
					if (firstTokenTime === null || firstTokenTime === undefined || firstTokenTime === 0)
						firstTokenTime = Date.now();
					if (parseMiniMaxThinkTags) {
						taggedTextBuffer += delta.content;
						flushTaggedTextBuffer();
					} else {
						appendTextDelta(delta.content);
					}
				}

				const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
				let foundReasoningField: string | null = null;
				for (const field of reasoningFields) {
					const value = (delta as Record<string, unknown>)[field];
					if (typeof value === "string" && value.length > 0) {
						if (foundReasoningField === null) {
							foundReasoningField = field;
							break;
						}
					}
				}

				if (foundReasoningField !== null && foundReasoningField !== undefined && foundReasoningField !== "") {
					const deltaValue = (delta as Record<string, unknown>)[foundReasoningField];
					if (typeof deltaValue === "string") {
						appendThinkingDelta(deltaValue, foundReasoningField);
					}
				}

				if (delta?.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						if (
							!currentBlock ||
							currentBlock.type !== "toolCall" ||
							(toolCall.id !== null &&
								toolCall.id !== undefined &&
								toolCall.id !== "" &&
								currentBlock.id !== toolCall.id)
						) {
							finishCurrentBlock(currentBlock);
							currentBlock = {
								type: "toolCall",
								id: toolCall.id ?? "",
								name: toolCall.function?.name ?? "",
								arguments: {},
								partialArgs: "",
							};
							output.content.push(currentBlock);
							stream.push({
								type: "toolcall_start",
								contentIndex: blockIndex(currentBlock),
								partial: output,
							});
						}

						if (currentBlock.type === "toolCall") {
							if (toolCall.id !== null && toolCall.id !== undefined && toolCall.id !== "")
								currentBlock.id = toolCall.id;
							if (
								toolCall.function?.name !== null &&
								toolCall.function?.name !== undefined &&
								toolCall.function?.name !== ""
							)
								currentBlock.name = toolCall.function.name;
							let argDelta = "";
							if (
								toolCall.function?.arguments !== null &&
								toolCall.function?.arguments !== undefined &&
								toolCall.function?.arguments !== ""
							) {
								argDelta = toolCall.function.arguments;
								currentBlock.partialArgs += toolCall.function.arguments;
								currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(currentBlock),
								delta: argDelta,
								partial: output,
							});
						}
					}
				}
			};

			for await (const chunk of iterateWithIdleTimeout(openaiStream, {
				watchdog: firstEventWatchdog,
				idleTimeoutMs,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
			})) {
				if (chunk === undefined || chunk === null || typeof chunk !== "object") continue;

				output.responseId ||= chunk.id;

				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (!chunk.usage) {
					const choiceUsage = getOptionalObjectProperty(choice, "usage");
					if (choiceUsage) {
						output.usage = parseChunkUsage(choiceUsage, model);
					}
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (
						finishReasonResult.errorMessage !== null &&
						finishReasonResult.errorMessage !== undefined &&
						finishReasonResult.errorMessage !== ""
					) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
				}

				if (choice.delta !== undefined) processChoiceDelta(choice.delta);
			}

			if (parseMiniMaxThinkTags && taggedTextBuffer.length > 0) {
				if (insideTaggedThinking) {
					appendThinkingDelta(taggedTextBuffer);
				} else {
					appendTextDelta(taggedTextBuffer);
				}
				taggedTextBuffer = "";
			}

			finishCurrentBlock(currentBlock);

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage ?? "Provider returned an error stop reason");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime !== null && firstTokenTime !== undefined && firstTokenTime !== 0)
				output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorMessage =
				firstEventTimeoutError?.message ??
				(await finalizeErrorMessage(error, rawRequestDump, getCapturedErrorResponse?.()));
			output.duration = Date.now() - startTime;
			if (firstTokenTime !== null && firstTokenTime !== undefined && firstTokenTime !== 0)
				output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

async function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
): Promise<{
	client: OpenAI;
	baseUrl: string | undefined;
	requestHeaders: Record<string, string>;
	getCapturedErrorResponse: () => CapturedHttpErrorResponse | undefined;
	clearCapturedErrorResponse: () => void;
}> {
	if (apiKey === null || apiKey === undefined || apiKey === "") {
		if (!$env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_API_KEY;
	}

	let headers = { ...model.headers, ...extraHeaders };
	if (model.provider === "kimi-code") {
		headers = { ...(await getKimiCommonHeaders()), ...headers };
	}

	const baseUrl = model.baseUrl;
	let capturedErrorResponse: CapturedHttpErrorResponse | undefined;
	const wrappedFetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await fetch(input, init);
			if (response.ok) {
				capturedErrorResponse = undefined;
				return response;
			}
			let bodyText: string | undefined;
			let bodyJson: unknown;
			try {
				bodyText = await response.clone().text();
				if (bodyText.trim().length > 0) {
					try {
						bodyJson = JSON.parse(bodyText);
					} catch {}
				}
			} catch {}
			capturedErrorResponse = {
				status: response.status,
				headers: response.headers,
				bodyText,
				bodyJson,
			};
			return response;
		},
		{ preconnect: fetch.preconnect },
	);
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: 5,
			defaultHeaders: headers,
			fetch: wrappedFetch,
		}),
		baseUrl,
		requestHeaders: headers,
		getCapturedErrorResponse: () => capturedErrorResponse,
		clearCapturedErrorResponse: () => {
			capturedErrorResponse = undefined;
		},
	};
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	resolvedBaseUrl?: string,
	toolStrictModeOverride?: ToolStrictModeOverride,
): { params: OpenAICompletionsSamplingParams; toolStrictMode: AppliedToolStrictMode } {
	const compat = resolveOpenAICompat(model, resolvedBaseUrl);
	const messages = convertMessages(model, context, compat);

	const effectiveMaxTokens = options?.maxTokens;

	const params: OpenAICompletionsSamplingParams = {
		model: model.id,
		messages,
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";

	if (compat.supportsUsageInStreaming !== false) {
		(params as { stream_options?: { include_usage: boolean } }).stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (effectiveMaxTokens !== null && effectiveMaxTokens !== undefined && effectiveMaxTokens !== 0) {
		if (compat.maxTokensField === "max_tokens") {
			(params as { max_tokens?: number }).max_tokens = effectiveMaxTokens;
		} else {
			params.max_completion_tokens = effectiveMaxTokens;
		}
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
	if (options?.repetitionPenalty !== undefined) {
		params.repetition_penalty = options.repetitionPenalty;
	}
	if (shouldSendServiceTier(options?.serviceTier, model.provider)) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools) {
		const builtTools = convertTools(context.tools, compat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
	}

	if (options?.toolChoice !== undefined && compat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}

	if (compat.thinkingFormat === "zai" && model.reasoning) {
		Reflect.set(params, "thinking", { type: options?.reasoning ? "enabled" : "disabled" });
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		Reflect.set(params, "enable_thinking", !!options?.reasoning);
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		Reflect.set(params, "chat_template_kwargs", { enable_thinking: !!options?.reasoning });
	} else if (options?.reasoning && model.reasoning && compat.supportsReasoningEffort) {
		Reflect.set(params, "reasoning_effort", mapReasoningEffort(options.reasoning, compat.reasoningEffortMap));
	}

	if (compat.disableReasoningOnForcedToolChoice && isForcedToolChoice(params.tool_choice)) {
		delete (params as { reasoning_effort?: unknown }).reasoning_effort;
	}

	if (compat.extraBody) {
		Object.assign(params, compat.extraBody);
	}

	return { params, toolStrictMode };
}

function getOptionalNumberProperty(value: object, key: string): number | undefined {
	const property = Reflect.get(value, key);
	return typeof property === "number" ? property : undefined;
}

function getOptionalObjectProperty(value: object, key: string): object | undefined {
	const property = Reflect.get(value, key);
	return typeof property === "object" && property !== null ? property : undefined;
}

export function parseChunkUsage(rawUsage: object, model: Model<"openai-completions">): AssistantMessage["usage"] {
	const promptTokenDetails = getOptionalObjectProperty(rawUsage, "prompt_tokens_details");
	const completionTokenDetails = getOptionalObjectProperty(rawUsage, "completion_tokens_details");
	const cachedTokens =
		getOptionalNumberProperty(rawUsage, "cached_tokens") ??
		(promptTokenDetails ? getOptionalNumberProperty(promptTokenDetails, "cached_tokens") : undefined) ??
		0;
	const cacheWriteTokens = promptTokenDetails
		? (getOptionalNumberProperty(promptTokenDetails, "cache_write_tokens") ?? 0)
		: 0;
	const reasoningTokens =
		(completionTokenDetails ? getOptionalNumberProperty(completionTokenDetails, "reasoning_tokens") : undefined) ?? 0;
	const promptTokens = getOptionalNumberProperty(rawUsage, "prompt_tokens") ?? 0;
	const input = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
	const outputTokens = getOptionalNumberProperty(rawUsage, "completion_tokens") ?? 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cachedTokens + cacheWriteTokens,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapReasoningEffort(
	effort: NonNullable<OpenAICompletionsOptions["reasoning"]>,
	reasoningEffortMap: Partial<Record<NonNullable<OpenAICompletionsOptions["reasoning"]>, string>>,
): string {
	return reasoningEffortMap[effort] ?? effort;
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

		if (id.includes("|")) {
			const [callId] = id.split("|");
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(context.messages, model, id => normalizeToolCallId(id));

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const rememberToolCallId = (originalId: string, normalizedId: string): void => {
		const queue = remappedToolCallIds.get(originalId);
		if (queue) {
			queue.push(normalizedId);
			return;
		}
		remappedToolCallIds.set(originalId, [normalizedId]);
	};

	const consumeToolCallId = (originalId: string): string | null => {
		const queue = remappedToolCallIds.get(originalId);
		if (!queue || queue.length === 0) return null;
		const nextId = queue.shift() ?? null;
		if (queue.length === 0) remappedToolCallIds.delete(originalId);
		return nextId;
	};

	const ensureToolCallId = (rawId: string, seed: string): string => {
		const normalized = normalizeToolCallId(rawId);
		if (normalized.trim().length > 0) return normalized;
		return generateFallbackToolCallId(seed);
	};

	if (context.systemPrompt !== null && context.systemPrompt !== undefined && context.systemPrompt !== "") {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role, content: context.systemPrompt.toWellFormed() });
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		const devAsUser = !compat.supportsDeveloperRole;
		if (msg.role === "user" || msg.role === "developer") {
			const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
			if (typeof msg.content === "string") {
				const text = msg.content.toWellFormed();
				if (text.trim().length === 0) continue;
				params.push({
					role,
					content: text,
				});
			} else {
				const content: ChatCompletionContentPart[] = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						content.push({
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText);
					} else {
						content.push({
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage);
					}
				}
				const filteredContent = model.input.includes("image")
					? content
					: content.filter(c => c.type !== "image_url");
				if (filteredContent.length === 0) continue;
				params.push({
					role: "user",
					content: filteredContent,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
			const nonEmptyTextBlocks = textBlocks.filter(b => b.text.trim().length > 0);
			if (nonEmptyTextBlocks.length > 0) {
				assistantMsg.content = nonEmptyTextBlocks.map(b => b.text.toWellFormed()).join("");
			}

			const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
			const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					const thinkingText = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n\n");
					const textContent = assistantMsg.content as Array<{ type: "text"; text: string }> | null;
					if (textContent) {
						textContent.unshift({ type: "text", text: thinkingText });
					} else {
						assistantMsg.content = [{ type: "text", text: thinkingText }];
					}
				} else {
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					if (signature !== null && signature !== undefined && signature !== "" && signature.length > 0) {
						(assistantMsg as unknown as Record<string, unknown>)[signature] = nonEmptyThinkingBlocks
							.map(b => b.thinking)
							.join("\n");
					}
				}
			}

			if (compat.thinkingFormat === "openai") {
				const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
				const reasoningField =
					streamedReasoningField === "reasoning_content" ||
					streamedReasoningField === "reasoning" ||
					streamedReasoningField === "reasoning_text"
						? streamedReasoningField
						: (compat.reasoningContentField ?? "reasoning_content");
				const reasoningContent = (assistantMsg as unknown as Record<string, unknown>)[reasoningField];
				if (reasoningContent === null || reasoningContent === undefined) {
					if (nonEmptyThinkingBlocks.length > 0) {
						(assistantMsg as unknown as Record<string, unknown>)[reasoningField] = nonEmptyThinkingBlocks
							.map(b => b.thinking)
							.join("\n");
					}
				}
			}

			const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
			const stubsReasoningContent =
				compat.requiresReasoningContentForToolCalls && compat.thinkingFormat === "openai";
			let hasReasoningField =
				(assistantMsg as unknown as Record<string, unknown>).reasoning_content !== undefined ||
				(assistantMsg as unknown as Record<string, unknown>).reasoning !== undefined ||
				(assistantMsg as unknown as Record<string, unknown>).reasoning_text !== undefined;
			if (toolCalls.length > 0 && stubsReasoningContent && !hasReasoningField) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				(assistantMsg as unknown as Record<string, unknown>)[reasoningField] = ".";
				hasReasoningField = true;
			}
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
					const toolCallId = ensureToolCallId(tc.id, `${i}:${toolCallIndex}:${tc.name}`);
					rememberToolCallId(tc.id, toolCallId);
					return {
						id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: serializeToolArguments(tc.arguments),
						},
					};
				});
			}
			if (assistantMsg.content === null && hasReasoningField) {
				assistantMsg.content = "";
			}
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
				assistantMsg.content = ".";
			}
			if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				const textResult = toolMsg.content
					.filter(c => c.type === "text")
					.map(c => (c as { type: "text"; text: string }).text)
					.join("\n");
				const hasImages = toolMsg.content.some(c => c.type === "image");

				const hasText = textResult.length > 0;
				const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
				const resolvedToolCallId =
					remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: (hasText ? textResult : "(see attached image)").toWellFormed(),
					tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as { name?: string }).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${(block as { mimeType: string }).mimeType};base64,${(block as { data: string }).data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole =
			msg.role === "developer"
				? (model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system")
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = tool.parameters as unknown as Record<string, unknown>;
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const resolveStrictMode = (): "none" | "all_strict" | "mixed" => {
		if (requestedStrictMode === "none") return "none";
		if (requestedStrictMode !== "all_strict") return "mixed";
		return adaptedTools.every(tool => tool.strict) ? "all_strict" : "none";
	};
	const toolStrictMode = resolveStrictMode();

	return {
		tools: adaptedTools.map(({ tool, baseParameters, parameters, strict }) => {
			const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					parameters: includeStrict ? parameters : baseParameters,
					...(includeStrict && { strict: true }),
				},
			};
		}),
		toolStrictMode,
	};
}

function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	toolStrictMode: AppliedToolStrictMode,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || tools.length === 0 || toolStrictMode !== "all_strict") {
		return false;
	}
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) {
		return false;
	}
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return /wrong_api_format|mixed values for 'strict'|tool[s]?\b.*strict|\bstrict\b.*tool/i.test(messageParts);
}

function mapStopReason(reason: unknown): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null || reason === undefined || typeof reason !== "string") return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 */
export function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompat {
	return detectOpenAICompat(model);
}

/**
 * Get resolved compatibility settings for a model.
 */
function getCompat(model: Model<"openai-completions">, resolvedBaseUrl?: string): ResolvedOpenAICompat {
	return resolveOpenAICompat(model, resolvedBaseUrl);
}
