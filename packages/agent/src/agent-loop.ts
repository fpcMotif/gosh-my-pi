import { EventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types";
import { createAbortedToolResult, executeToolCalls } from "./agent-loop/execution";
import { streamAssistantResponse } from "./agent-loop/streaming";

/* eslint-disable no-await-in-loop */

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

	while (true) {
		const result = await processLoopTurn(
			currentContext,
			newMessages,
			config,
			signal,
			stream,
			streamFn,
			firstTurn,
			pendingMessages,
		);
		if (result.terminated) return;

		firstTurn = false;
		pendingMessages = result.nextPendingMessages;

		const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

async function processLoopTurn(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn: StreamFn | undefined,
	firstTurn: boolean,
	initialPendingMessages: AgentMessage[],
): Promise<{ terminated: boolean; nextPendingMessages: AgentMessage[] }> {
	let pendingMessages = initialPendingMessages;
	let hasMoreToolCalls = true;

	while (hasMoreToolCalls || pendingMessages.length > 0) {
		if (firstTurn) {
			firstTurn = false;
		} else {
			stream.push({ type: "turn_start" });
		}

		if (pendingMessages.length > 0) {
			handlePendingMessages(pendingMessages, currentContext, newMessages, stream);
			pendingMessages = [];
		}

		if (config.syncContextBeforeModelCall) {
			await config.syncContextBeforeModelCall(currentContext);
		}

		const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
		newMessages.push(message);

		const terminalResult = checkTerminalResponse(message, currentContext, newMessages, stream);
		if (terminalResult.terminated) return terminalResult;

		const executionResult = await handleToolCallsStep(currentContext, message, signal, stream, config, newMessages);
		pendingMessages = executionResult.pendingMessages;
		hasMoreToolCalls = executionResult.hasMoreToolCalls;

		stream.push({ type: "turn_end", message, toolResults: executionResult.toolResults });

		if (pendingMessages.length === 0) {
			pendingMessages = (await config.getSteeringMessages?.()) ?? [];
		}
	}

	return { terminated: false, nextPendingMessages: [] };
}

function checkTerminalResponse(
	message: AssistantMessage,
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	stream: EventStream<AgentEvent, AgentMessage[]>,
): { terminated: boolean; nextPendingMessages: AgentMessage[] } {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		handleTerminalAssistantResponse(message, currentContext, newMessages, stream);
		return { terminated: true, nextPendingMessages: [] };
	}
	return { terminated: false, nextPendingMessages: [] };
}

async function handleToolCallsStep(
	currentContext: AgentContext,
	message: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	newMessages: AgentMessage[],
): Promise<{ pendingMessages: AgentMessage[]; hasMoreToolCalls: boolean; toolResults: ToolResultMessage[] }> {
	const executionResult = await handleToolCallsIfAny(currentContext, message, signal, stream, config);
	let pendingMessages: AgentMessage[] = [];
	const toolResults = executionResult?.toolResults ?? [];

	if (executionResult) {
		for (const result of executionResult.toolResults) {
			currentContext.messages.push(result);
			newMessages.push(result);
		}
		pendingMessages = executionResult.steeringMessages ?? [];
	}

	const toolCallsCount = message.content.filter(c => c.type === "toolCall").length;
	const hasMoreToolCalls = toolCallsCount > 0 && pendingMessages.length === 0;

	return { pendingMessages, hasMoreToolCalls, toolResults };
}

async function handleToolCallsIfAny(
	currentContext: AgentContext,
	message: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
) {
	const toolCalls = message.content.filter(c => c.type === "toolCall");
	if (toolCalls.length === 0) return null;

	return executeToolCalls(currentContext.tools, message, signal, stream, config);
}

function handlePendingMessages(
	pendingMessages: AgentMessage[],
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	stream: EventStream<AgentEvent, AgentMessage[]>,
) {
	for (const message of pendingMessages) {
		stream.push({ type: "message_start", message });
		stream.push({ type: "message_end", message });
		currentContext.messages.push(message);
		newMessages.push(message);
	}
}

function handleTerminalAssistantResponse(
	message: AssistantMessage,
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	stream: EventStream<AgentEvent, AgentMessage[]>,
) {
	const toolCalls = message.content.filter(
		(c): c is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => c.type === "toolCall",
	);
	const toolResults = toolCalls.map(toolCall => {
		const result = createAbortedToolResult(toolCall, stream, message.stopReason, message.errorMessage);
		currentContext.messages.push(result);
		newMessages.push(result);
		return result;
	});
	stream.push({ type: "turn_end", message, toolResults });
}

/**
 * Start an agent loop with a new prompt message.
 */
export function agentLoop(
	messages: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = new EventStream<AgentEvent, AgentMessage[]>();
	const newMessages: AgentMessage[] = [];

	void runLoop(context, newMessages, config, signal, stream, streamFn);

	return stream;
}

/**
 * Continue an existing agent loop.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = new EventStream<AgentEvent, AgentMessage[]>();
	const newMessages: AgentMessage[] = [];

	void runLoop(context, newMessages, config, signal, stream, streamFn);

	return stream;
}
