import {
	type AssistantMessage,
	type AssistantMessageEvent,
	AssistantMessageEventStream as ProxyMessageEventStream,
	type Effort,
	type Message,
	type Model,
	type ProviderSessionState,
	parseStreamingJson,
} from "@oh-my-pi/pi-ai";
import { readSseJson } from "@oh-my-pi/pi-utils";
import type { ProxyAssistantMessageEvent } from "./types";

export type ProxyStreamOptions = {
	proxyUrl: string;
	authToken: string;
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	maxTokens?: number;
	reasoning?: Effort;
	signal?: AbortSignal;
	providerSessionState?: Map<string, ProviderSessionState>;
};

/**
 * Stream an assistant message via a proxy.
 */
export function streamProxy(
	model: Model,
	context: { messages: Message[]; systemPrompt?: string },
	options: ProxyStreamOptions,
): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	void (async () => {
		const partial = createInitialPartial(model);
		let response: Response | null = null;
		const abortHandler = () => {
			void response?.body?.cancel("Request aborted by user").catch(() => {});
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: extractStreamOptions(options),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				throw await createProxyError(response);
			}

			await processStream(response, options, partial, stream);
		} catch (error) {
			handleStreamError(error, options, partial, stream);
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

async function processStream(
	response: Response,
	options: ProxyStreamOptions,
	partial: AssistantMessage,
	stream: ProxyMessageEventStream,
) {
	let sawTerminalEvent = false;
	if (response.body) {
		for await (const event of readSseJson<ProxyAssistantMessageEvent>(
			response.body as ReadableStream<Uint8Array>,
			options.signal,
		)) {
			const parsedEvent = processProxyEvent(event, partial);
			if (parsedEvent) {
				if (parsedEvent.type === "done" || parsedEvent.type === "error") {
					sawTerminalEvent = true;
				}
				stream.push(parsedEvent);
			}
		}
	}

	if (options.signal?.aborted === true && !sawTerminalEvent) {
		const reason = options.signal.reason;
		throw reason instanceof Error ? reason : new Error(String(reason ?? "Request aborted"));
	}

	stream.end();
}

function createInitialPartial(model: Model): AssistantMessage {
	return {
		role: "assistant",
		stopReason: "stop",
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
		timestamp: Date.now(),
	};
}

function extractStreamOptions(options: ProxyStreamOptions) {
	return {
		temperature: options.temperature,
		topP: options.topP,
		topK: options.topK,
		minP: options.minP,
		presencePenalty: options.presencePenalty,
		repetitionPenalty: options.repetitionPenalty,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
	};
}

async function createProxyError(response: Response): Promise<Error> {
	let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
	try {
		const errorData = (await response.json()) as { error?: string };
		if (errorData.error !== null && errorData.error !== undefined && errorData.error !== "") {
			errorMessage = `Proxy error: ${errorData.error}`;
		}
	} catch {
		// Couldn't parse error response
	}
	return new Error(errorMessage);
}

function handleStreamError(
	error: unknown,
	options: ProxyStreamOptions,
	partial: AssistantMessage,
	stream: ProxyMessageEventStream,
) {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const reason = options.signal?.aborted === true ? "aborted" : "error";
	partial.stopReason = reason;
	partial.errorMessage = errorMessage;
	stream.push({
		type: "error",
		reason,
		error: partial,
	});
	stream.end();
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	const type = proxyEvent.type;
	if (type === "start") return { type: "start", partial };
	if (type === "done") return { type: "done", message: partial };
	if (type === "error") {
		partial.stopReason = proxyEvent.reason;
		partial.errorMessage = proxyEvent.message;
		return { type: "error", reason: proxyEvent.reason, error: partial };
	}
	if (type === "usage") {
		partial.usage = proxyEvent.usage;
		return { type: "usage", usage: proxyEvent.usage, partial };
	}

	return handleContentEvent(proxyEvent, partial);
}

function handleContentEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };
		case "text_delta":
			return handleTextDelta(proxyEvent, partial);
		case "text_end":
			return handleTextEnd(proxyEvent, partial);
		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };
		case "thinking_delta":
			return handleThinkingDelta(proxyEvent, partial);
		case "thinking_end":
			return handleThinkingEnd(proxyEvent, partial);
		case "toolcall_start":
			return handleToolCallStart(proxyEvent, partial);
		case "toolcall_delta":
			return handleToolCallDelta(proxyEvent, partial);
		case "toolcall_end":
			return handleToolCallEnd(proxyEvent, partial);
		default:
			return undefined;
	}
}

function handleTextDelta(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "text_delta" }>;
	const content = partial.content[event.contentIndex];
	if (content?.type === "text") {
		content.text += event.delta;
		return {
			type: "text_delta",
			contentIndex: event.contentIndex,
			delta: event.delta,
			partial,
		};
	}
	throw new Error("Received text_delta for non-text content");
}

function handleTextEnd(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "text_end" }>;
	const content = partial.content[event.contentIndex];
	if (content?.type === "text") {
		content.textSignature = event.contentSignature;
		return {
			type: "text_end",
			contentIndex: event.contentIndex,
			content: content.text,
			partial,
		};
	}
	throw new Error("Received text_end for non-text content");
}

function handleThinkingDelta(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "thinking_delta" }>;
	const content = partial.content[event.contentIndex];
	if (content?.type === "thinking") {
		content.thinking += event.delta;
		return {
			type: "thinking_delta",
			contentIndex: event.contentIndex,
			delta: event.delta,
			partial,
		};
	}
	throw new Error("Received thinking_delta for non-thinking content");
}

function handleThinkingEnd(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "thinking_end" }>;
	const content = partial.content[event.contentIndex];
	if (content?.type === "thinking") {
		content.thinkingSignature = event.contentSignature;
		return {
			type: "thinking_end",
			contentIndex: event.contentIndex,
			content: content.thinking,
			partial,
		};
	}
	throw new Error("Received thinking_end for non-thinking content");
}

function handleToolCallStart(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "toolcall_start" }>;
	const toolCall: ToolCall = {
		type: "toolCall",
		id: event.id,
		name: event.toolName,
		arguments: {},
	};
	// Store partialJson on the object temporarily (not part of ToolCall type but we need it for streaming)
	(toolCall as unknown as { partialJson: string }).partialJson = "";
	partial.content[event.contentIndex] = toolCall;
	return { type: "toolcall_start", contentIndex: event.contentIndex, partial };
}

function handleToolCallDelta(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "toolcall_delta" }>;
	const content = partial.content[event.contentIndex];
	if (content?.type === "toolCall") {
		const pc = content as unknown as { partialJson: string };
		pc.partialJson += event.delta;
		content.arguments = (parseStreamingJson(pc.partialJson) ?? {}) as Record<string, unknown>;
		partial.content[event.contentIndex] = { ...content }; // Trigger reactivity
		return {
			type: "toolcall_delta",
			contentIndex: event.contentIndex,
			delta: event.delta,
			partial,
		};
	}
	throw new Error("Received toolcall_delta for non-toolCall content");
}

function handleToolCallEnd(proxyEvent: ProxyAssistantMessageEvent, partial: AssistantMessage): AssistantMessageEvent {
	const event = proxyEvent as Extract<ProxyAssistantMessageEvent, { type: "toolcall_end" }>;
	const content = partial.content[event.contentIndex];
	if (content?.type === "toolCall") {
		const pc = content as unknown as { partialJson?: string };
		delete pc.partialJson;
		return {
			type: "toolcall_end",
			contentIndex: event.contentIndex,
			toolCall: content,
			partial,
		};
	}
	throw new Error("Received toolcall_end for non-toolCall content");
}
