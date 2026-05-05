import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	streamSimple,
	transformMessages,
	type Tool,
} from "@oh-my-pi/pi-ai";
import type { EventStream } from "@oh-my-pi/pi-ai";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AnyAgentTool, StreamFn } from "../types";

const INTENT_FIELD = "intent";

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
export async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = transformMessages(llmMessages, config.model);

	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: normalizedMessages,
		tools: normalizeTools(context.tools ?? [], config.intentTracing === true),
	};

	const streamFunction = streamFn || streamSimple;

	const apiKeyFromConfig = config.getApiKey ? await config.getApiKey(config.model.provider) : undefined;
	const resolvedApiKey =
		apiKeyFromConfig !== undefined && apiKeyFromConfig !== null && apiKeyFromConfig !== ""
			? apiKeyFromConfig
			: config.apiKey;

	const dynamicToolChoice = config.getToolChoice?.();
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		toolChoice: dynamicToolChoice ?? config.toolChoice,
		signal,
	});

	return processAssistantStream(response, config, signal, context, stream);
}

async function processAssistantStream(
	response: AsyncIterable<AssistantMessageEvent>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<AssistantMessage> {
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		if (signal !== undefined && signal.aborted) {
			return handleAbortedStream(config, partialMessage, addedPartial, context, stream);
		}

		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				break;

			case "done":
				return finishPartialMessage(event.message, addedPartial, context, stream);

			case "error":
				return finishPartialMessage(event.error, addedPartial, context, stream);

			default:
				if (partialMessage) {
					if (!addedPartial) {
						context.messages.push(partialMessage);
						stream.push({ type: "message_start", message: partialMessage });
						addedPartial = true;
					}
					stream.push({ type: "message_update", message: partialMessage, assistantMessageEvent: event });
				}
				break;
		}
	}

	throw new Error("Stream ended without done or error event");
}

function finishPartialMessage(
	message: AssistantMessage,
	addedPartial: boolean,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): AssistantMessage {
	if (addedPartial) {
		context.messages[context.messages.length - 1] = message;
	} else {
		context.messages.push(message);
		stream.push({ type: "message_start", message: { ...message } });
	}
	stream.push({ type: "message_end", message });
	return message;
}

function handleAbortedStream(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): AssistantMessage {
	const errorMessage = "Request was aborted";
	const abortedMessage: AssistantMessage = partialMessage
		? { ...partialMessage, stopReason: "aborted", errorMessage }
		: {
				role: "assistant",
				content: [],
				api: config.model.api,
				provider: config.model.provider,
				model: config.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage,
				timestamp: Date.now(),
			};
	return finishPartialMessage(abortedMessage, addedPartial, context, stream);
}

function normalizeTools(tools: AnyAgentTool[], tracing: boolean): Tool[] {
	return tools.map(t => {
		const tool: Tool = {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
			strict: t.strict,
		};

		if (tracing && t.intent !== undefined && t.intent !== null) {
			const mode = resolveIntentMode(t.intent);
			if (mode !== "omit") {
				const params = { ...t.parameters };
				params.properties = {
					...(params.properties as Record<string, unknown>),
					[INTENT_FIELD]: {
						type: "string",
						description: "Optional intent tracing identifier",
					},
				};
				if (mode === "require") {
					params.required = [...(params.required ?? []), INTENT_FIELD];
				}
				tool.parameters = params;
			}
		}

		return tool;
	});
}

function resolveIntentMode(intent: AnyAgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}
