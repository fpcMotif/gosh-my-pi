import { type AssistantMessage, type EventStream, type ToolCall, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AnyAgentTool, ToolCallContext } from "../types";

export const INTENT_FIELD = "intent";

export function createAbortedToolResult(
	toolCall: ToolCall,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	stopReason: string,
	errorMessage?: string,
): ToolResultMessage {
	const stopReasonText =
		errorMessage !== undefined && errorMessage !== null && errorMessage !== "" ? `: ${errorMessage}` : ".";
	const baseText =
		stopReason === "aborted"
			? "Tool execution was aborted"
			: `Tool execution was skipped because the request was ${stopReason}`;
	const errorText = `${baseText}${stopReasonText}`;
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: errorText }],
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: true });

	return result;
}

function createSkippedToolResult(
	toolCall: ToolCall,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: true });

	return result;
}

/* eslint-disable no-await-in-loop */

/**
 * Execute multiple tool calls, checking for steering messages between calls if interruptMode is "immediate".
 */
type BatchInfo = {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
};

export async function executeToolCalls(
	tools: AnyAgentTool[],
	message: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const toolCalls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
	if (config.interruptMode === "immediate") {
		return executeToolCallsWithImmediateSteering(tools, toolCalls, signal, stream, config);
	}

	return executeToolCallsWithConcurrency(tools, toolCalls, signal, stream, config);
}

async function executeToolCallsWithImmediateSteering(
	tools: AnyAgentTool[],
	toolCalls: ToolCall[],
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const toolResults: ToolResultMessage[] = [];
	const batchId = crypto.randomUUID();
	const batchToolCalls = toolCalls.map(tc => ({ id: tc.id, name: tc.name }));

	for (let i = 0; i < toolCalls.length; i++) {
		const toolCall = toolCalls[i];
		const steeringMessages = (await config.getSteeringMessages?.()) ?? [];
		if (steeringMessages.length > 0) {
			if (toolResults.length > 0) {
				for (const skippedToolCall of toolCalls.slice(i)) {
					toolResults.push(createSkippedToolResult(skippedToolCall, stream));
				}
			}
			return { toolResults, steeringMessages };
		}

		if (signal !== undefined && signal.aborted) {
			toolResults.push(createAbortedToolResult(toolCall, stream, "aborted"));
			continue;
		}

		const batch: BatchInfo = { batchId, index: i, total: toolCalls.length, toolCalls: batchToolCalls };
		const result = await executeSingleToolCall(tools, toolCall, signal, stream, config, batch);
		toolResults.push(result);
	}

	return { toolResults };
}

async function executeToolCallsWithConcurrency(
	tools: AnyAgentTool[],
	toolCalls: ToolCall[],
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): Promise<{ toolResults: ToolResultMessage[] }> {
	const toolResults: ToolResultMessage[] = [];
	const batchId = crypto.randomUUID();
	const batchToolCalls = toolCalls.map(tc => ({ id: tc.id, name: tc.name }));
	let sharedCalls: Array<{ toolCall: ToolCall; index: number }> = [];

	const flushSharedCalls = async () => {
		if (sharedCalls.length === 0) return;
		const completedResults: ToolResultMessage[] = [];
		const pending = sharedCalls.map(({ toolCall, index }) => {
			const batch: BatchInfo = { batchId, index, total: toolCalls.length, toolCalls: batchToolCalls };
			if (signal !== undefined && signal.aborted) {
				completedResults.push(createAbortedToolResult(toolCall, stream, "aborted"));
				return Promise.resolve();
			}
			return executeSingleToolCall(tools, toolCall, signal, stream, config, batch).then(result => {
				completedResults.push(result);
			});
		});
		await Promise.all(pending);
		toolResults.push(...completedResults);
		sharedCalls = [];
	};

	for (let i = 0; i < toolCalls.length; i++) {
		const toolCall = toolCalls[i];
		const tool = tools.find(t => t.name === toolCall.name);
		if (tool?.concurrency === "exclusive") {
			await flushSharedCalls();
			if (signal !== undefined && signal.aborted) {
				toolResults.push(createAbortedToolResult(toolCall, stream, "aborted"));
				continue;
			}
			const batch: BatchInfo = { batchId, index: i, total: toolCalls.length, toolCalls: batchToolCalls };
			toolResults.push(await executeSingleToolCall(tools, toolCall, signal, stream, config, batch));
			continue;
		}
		sharedCalls.push({ toolCall, index: i });
	}

	await flushSharedCalls();
	return { toolResults };
}

async function executeSingleToolCall(
	tools: AnyAgentTool[],
	toolCall: ToolCall,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	batch: BatchInfo,
): Promise<ToolResultMessage> {
	const tool = tools.find(t => t.name === toolCall.name);
	const { args, intent } = prepareToolArgs(toolCall, config);

	stream.push({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args, intent });

	if (!tool) {
		return handleToolNotFound(toolCall, tools, stream);
	}

	try {
		return await performToolExecution(tool, toolCall, args, signal, stream, config, batch);
	} catch (error: unknown) {
		return handleToolExecutionError(error, toolCall, stream);
	}
}

function prepareToolArgs(toolCall: ToolCall, config: AgentLoopConfig) {
	let args = toolCall.arguments;
	let intent: string | undefined;

	if (config.intentTracing === true) {
		const extracted = extractIntent(args);
		args = extracted.strippedArgs;
		intent = extracted.intent;
		toolCall.arguments = args;
		if (intent !== undefined) {
			toolCall.intent = intent;
		} else {
			delete toolCall.intent;
		}
	}

	if (config.transformToolCallArguments) {
		args = config.transformToolCallArguments(args, toolCall.name);
	}
	return { args, intent };
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs: args };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

function handleToolNotFound(
	toolCall: ToolCall,
	tools: AnyAgentTool[],
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	// Surface the available tool names so the LLM can self-correct on the next
	// turn. Without this list the model has no signal for what to try instead
	// and tends to loop calling the wrong name.
	const availableNames = tools.map(t => t.name).sort((a, b) => a.localeCompare(b));
	const availableText =
		availableNames.length > 0 ? `Available tools: ${availableNames.join(", ")}.` : "No tools are available.";
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: `Error: Tool "${toolCall.name}" not found. ${availableText}` }],
		isError: true,
		timestamp: Date.now(),
	};
	stream.push({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: true });
	return result;
}

async function performToolExecution(
	tool: AnyAgentTool,
	toolCall: ToolCall,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	batch: BatchInfo,
): Promise<ToolResultMessage> {
	const toolCallContext: ToolCallContext = {
		batchId: batch.batchId,
		index: batch.index,
		total: batch.total,
		toolCalls: batch.toolCalls,
	};
	const toolContext = config.getToolContext?.(toolCallContext);

	const toolResult = await tool.execute(
		toolCall.id,
		args,
		signal,
		partialResult =>
			stream.push({
				type: "tool_execution_update",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args,
				partialResult,
			}),
		toolContext,
	);

	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: toolResult.content,
		details: toolResult.details,
		isError: false,
		timestamp: Date.now(),
	};

	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result: toolResult,
		isError: result.isError,
	});
	return result;
}

function handleToolExecutionError(
	error: unknown,
	toolCall: ToolCall,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: `Error: ${errorMessage}` }],
		isError: true,
		timestamp: Date.now(),
	};
	stream.push({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: true });
	return result;
}
