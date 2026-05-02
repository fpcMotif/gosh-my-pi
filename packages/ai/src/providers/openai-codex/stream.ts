import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { type AssistantMessage, type AssistantMessageEvent, type Model, type ToolCall } from "../../types";
import { parseStreamingJson } from "../../utils/json-parse";
import { encodeResponsesToolCallId, encodeTextSignatureV1 } from "../openai-responses-shared";
import type {
	ResponseReasoningItem,
	ResponseOutputMessage,
	ResponseFunctionToolCall,
	ResponseCustomToolCall,
} from "openai/resources/responses/responses";
import type { CodexTransport, CodexWebSocketSessionState } from "./websocket";
import type { RequestBody } from "./request-transformer";

export type CodexEventItem =
	| ResponseReasoningItem
	| ResponseOutputMessage
	| ResponseFunctionToolCall
	| ResponseCustomToolCall;

export type CodexOutputBlock =
	| { type: "thinking"; thinking: string; thinkingSignature?: string; itemId?: string }
	| { type: "text"; text: string; textSignature?: string }
	| (ToolCall & { partialJson: string });

export interface CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
	currentItem: CodexEventItem | null;
	currentBlock: CodexOutputBlock | null;
	nativeOutputItems: Array<Record<string, unknown>>;
	websocketStreamRetries: number;
	providerRetryAttempt: number;
	sawTerminalEvent: boolean;
	canSafelyReplayWebsocketOverSse: boolean;
}

export function createOutputBlockForItem(item: CodexEventItem): CodexOutputBlock | null {
	if (item.type === "reasoning") {
		return { type: "thinking", thinking: "", itemId: item.id };
	}
	if (item.type === "message") {
		return { type: "text", text: "" };
	}
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: {},
			partialJson: item.arguments ?? "",
		};
	}
	if (item.type === "custom_tool_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: item.input ?? "" },
			customWireName: item.name,
			partialJson: item.input ?? "",
		};
	}
	return null;
}

export function handleCodexStreamEvent(args: {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: (event: AssistantMessageEvent) => void;
	runtime: CodexStreamRuntime;
	rawEvent: Record<string, unknown>;
	firstTokenTime?: number;
}): number | undefined {
	const { output, stream, runtime, rawEvent } = args;
	const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
	if (eventType === "") return args.firstTokenTime;

	const blockIndex = () => output.content.length - 1;
	let firstTokenTime = args.firstTokenTime;

	switch (eventType) {
		case "response.output_item.added":
			if (firstTokenTime === null || firstTokenTime === undefined || firstTokenTime === 0)
				firstTokenTime = Date.now();
			runtime.currentItem = rawEvent.item as CodexEventItem;
			runtime.currentBlock = createOutputBlockForItem(runtime.currentItem);
			if (runtime.currentBlock) {
				output.content.push(runtime.currentBlock);
				stream({
					type: getOutputBlockStartEventType(runtime.currentBlock),
					contentIndex: blockIndex(),
					partial: output,
				});
			}
			break;
		case "response.reasoning_summary_part.added":
			handleReasoningSummaryPartAdded(runtime, rawEvent);
			break;
		case "response.reasoning_summary_text.delta":
			handleReasoningSummaryTextDelta(runtime, rawEvent, stream, output, blockIndex());
			break;
		case "response.reasoning_summary_part.done":
			handleReasoningSummaryPartDone(runtime, stream, output, blockIndex());
			break;
		case "response.content_part.added":
			handleContentPartAdded(runtime, rawEvent);
			break;
		case "response.output_text.delta":
			handleMessageTextDelta(runtime, rawEvent, stream, output, blockIndex(), "output_text");
			break;
		case "response.refusal.delta":
			handleMessageTextDelta(runtime, rawEvent, stream, output, blockIndex(), "refusal");
			break;
		case "response.function_call_arguments.delta":
			handleToolCallArgumentsDelta(runtime, rawEvent, stream, output, blockIndex());
			break;
		case "response.custom_tool_call_input.delta":
			handleCustomToolCallInputDelta(runtime, rawEvent, stream, output, blockIndex());
			break;
		case "response.output_item.done":
			handleOutputItemDoneSplit(args.model, output, stream, runtime, rawEvent, blockIndex());
			break;
		case "response.created":
			handleResponseCreated(runtime, rawEvent);
			break;
		case "response.completed":
		case "response.done":
		case "response.incomplete":
			handleResponseCompletedSplit(args.model, output, runtime, rawEvent);
			break;
		case "error":
		case "response.failed":
			throw createCodexProviderStreamError(rawEvent);
	}

	return firstTokenTime;
}

function getOutputBlockStartEventType(block: CodexOutputBlock): "thinking_start" | "text_start" | "toolcall_start" {
	if (block.type === "thinking") return "thinking_start";
	if (block.type === "text") return "text_start";
	return "toolcall_start";
}

function handleReasoningSummaryPartAdded(runtime: CodexStreamRuntime, rawEvent: Record<string, unknown>): void {
	if (runtime.currentItem?.type !== "reasoning") return;
	runtime.currentItem.summary = runtime.currentItem.summary ?? [];
	runtime.currentItem.summary.push((rawEvent as { part: ResponseReasoningItem["summary"][number] }).part);
}

function handleReasoningSummaryTextDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	stream: (event: AssistantMessageEvent) => void,
	output: AssistantMessage,
	blockIndex: number,
): void {
	if (runtime.currentItem?.type !== "reasoning" || runtime.currentBlock?.type !== "thinking") return;
	const lastPart = runtime.currentItem.summary?.[runtime.currentItem.summary.length - 1];
	if (lastPart === undefined || lastPart === null) return;
	const delta = (rawEvent as { delta?: string }).delta ?? "";
	runtime.currentBlock.thinking += delta;
	lastPart.text += delta;
	stream({ type: "thinking_delta", contentIndex: blockIndex, delta, partial: output });
}

function handleReasoningSummaryPartDone(
	runtime: CodexStreamRuntime,
	stream: (event: AssistantMessageEvent) => void,
	output: AssistantMessage,
	blockIndex: number,
): void {
	if (runtime.currentItem?.type !== "reasoning" || runtime.currentBlock?.type !== "thinking") return;
	const lastPart = runtime.currentItem.summary?.[runtime.currentItem.summary.length - 1];
	if (lastPart === undefined || lastPart === null) return;
	runtime.currentBlock.thinking += "\n\n";
	lastPart.text += "\n\n";
	stream({ type: "thinking_delta", contentIndex: blockIndex, delta: "\n\n", partial: output });
}

function handleContentPartAdded(runtime: CodexStreamRuntime, rawEvent: Record<string, unknown>): void {
	if (runtime.currentItem?.type !== "message") return;
	runtime.currentItem.content = runtime.currentItem.content ?? [];
	const part = (rawEvent as { part?: ResponseOutputMessage["content"][number] }).part;
	if (part !== undefined && part !== null && (part.type === "output_text" || part.type === "refusal")) {
		runtime.currentItem.content.push(part);
	}
}

function handleMessageTextDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	stream: (event: AssistantMessageEvent) => void,
	output: AssistantMessage,
	blockIndex: number,
	partType: "output_text" | "refusal",
): void {
	if (runtime.currentItem?.type !== "message" || runtime.currentBlock?.type !== "text") return;
	const lastPart = runtime.currentItem.content?.[runtime.currentItem.content.length - 1];
	if (lastPart === undefined || lastPart === null || lastPart.type !== partType) return;
	const delta = (rawEvent as { delta?: string }).delta ?? "";
	runtime.currentBlock.text += delta;
	if (lastPart.type === "output_text") lastPart.text += delta;
	else lastPart.refusal += delta;
	stream({ type: "text_delta", contentIndex: blockIndex, delta, partial: output });
}

function handleToolCallArgumentsDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	stream: (event: AssistantMessageEvent) => void,
	output: AssistantMessage,
	blockIndex: number,
): void {
	if (runtime.currentItem?.type !== "function_call" || runtime.currentBlock?.type !== "toolCall") return;
	const delta = (rawEvent as { delta?: string }).delta ?? "";
	runtime.currentBlock.partialJson += delta;
	runtime.currentBlock.arguments = parseStreamingJson(runtime.currentBlock.partialJson);
	stream({ type: "toolcall_delta", contentIndex: blockIndex, delta, partial: output });
}

function handleCustomToolCallInputDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	stream: (event: AssistantMessageEvent) => void,
	output: AssistantMessage,
	blockIndex: number,
): void {
	if (runtime.currentItem?.type !== "custom_tool_call" || runtime.currentBlock?.type !== "toolCall") return;
	const delta = (rawEvent as { delta?: string }).delta ?? "";
	runtime.currentBlock.partialJson += delta;
	runtime.currentBlock.arguments = { input: runtime.currentBlock.partialJson };
	stream({ type: "toolcall_delta", contentIndex: blockIndex, delta, partial: output });
}

function handleOutputItemDoneSplit(
	model: Model<"openai-codex-responses">,
	output: AssistantMessage,
	stream: (event: AssistantMessageEvent) => void,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	blockIndex: number,
): void {
	const item = structuredCloneJSON(rawEvent.item) as CodexEventItem;
	runtime.nativeOutputItems.push(item as unknown as Record<string, unknown>);

	if (item.type === "reasoning" && runtime.currentBlock?.type === "thinking") {
		runtime.currentBlock.thinking = item.summary?.map(summary => summary.text).join("\n\n") || "";
		runtime.currentBlock.thinkingSignature = JSON.stringify(item);
		stream({
			type: "thinking_end",
			contentIndex: blockIndex,
			content: runtime.currentBlock.thinking,
			partial: output,
		});
		runtime.currentBlock = null;
	} else if (item.type === "message" && runtime.currentBlock?.type === "text") {
		runtime.currentBlock.text = item.content
			.map(content => (content.type === "output_text" ? content.text : content.refusal))
			.join("");
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
		runtime.currentBlock.textSignature = encodeTextSignatureV1(item.id, phase);
		stream({
			type: "text_end",
			contentIndex: blockIndex,
			content: runtime.currentBlock.text,
			partial: output,
		});
		runtime.currentBlock = null;
	} else if (item.type === "function_call" || item.type === "custom_tool_call") {
		runtime.canSafelyReplayWebsocketOverSse = false;
		const toolCall = buildFinalToolCall(item, runtime.currentBlock);
		stream({ type: "toolcall_end", contentIndex: blockIndex, toolCall, partial: output });
		runtime.currentBlock = null;
	}
	void model;
}

function buildFinalToolCall(
	item: ResponseFunctionToolCall | ResponseCustomToolCall,
	currentBlock: CodexOutputBlock | null,
): ToolCall {
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: parseStreamingJson(item.arguments || "{}") as Record<string, unknown>,
		};
	}
	const rawInput =
		currentBlock?.type === "toolCall" && currentBlock.partialJson ? currentBlock.partialJson : (item.input ?? "");
	return {
		type: "toolCall",
		id: encodeResponsesToolCallId(item.call_id, item.id),
		name: item.name,
		arguments: { input: rawInput },
		customWireName: item.name,
	};
}

function handleResponseCreated(runtime: CodexStreamRuntime, rawEvent: Record<string, unknown>): void {
	const response = (rawEvent as { response?: { id?: string } }).response;
	if (
		runtime.transport === "websocket" &&
		runtime.websocketState &&
		typeof response?.id === "string" &&
		response.id.length > 0
	) {
		runtime.websocketState.lastResponseId = response.id;
	}
}

function handleResponseCompletedSplit(
	model: Model<"openai-codex-responses">,
	output: AssistantMessage,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
): void {
	runtime.sawTerminalEvent = true;
	const response = (rawEvent as any).response;
	if (response?.usage) {
		const cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
		const reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
		output.usage = {
			input: (response.usage.input_tokens ?? 0) - cachedTokens,
			output: response.usage.output_tokens ?? 0,
			cacheRead: cachedTokens,
			cacheWrite: 0,
			totalTokens: response.usage.total_tokens ?? 0,
			...(reasoningTokens > 0 ? { reasoningTokens } : {}),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
	if (typeof response?.id === "string" && response.id.length > 0) output.responseId = response.id;

	if (runtime.transport === "websocket" && runtime.websocketState) {
		runtime.websocketState.lastRequest = structuredCloneJSON(runtime.requestBodyForState);
		if (typeof response?.id === "string" && response.id.length > 0)
			runtime.websocketState.lastResponseId = response.id;
		runtime.websocketState.canAppend = rawEvent.type === "response.done";
	}
	void model;
}

class CodexProviderStreamError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "CodexProviderStreamError";
	}
}

function createCodexProviderStreamError(event: Record<string, unknown>): Error {
	const error = (event.error ||
		(event.type === "response.failed" ? (event.response as any)?.status_details?.error : null)) as Record<
		string,
		unknown
	> | null;
	const code = typeof error?.code === "string" ? error.code : "unknown_error";
	const message = typeof error?.message === "string" ? error.message : "An unknown error occurred";
	return new CodexProviderStreamError(code, message);
}
