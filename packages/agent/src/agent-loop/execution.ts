import { type AssistantMessage, type ToolCall, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AnyAgentTool, ToolCallContext } from "../types";
import type { EventStream } from "../utils/event-stream";

const INTENT_FIELD = "intent";

export function createAbortedToolResult(
	toolCall: ToolCall,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	stopReason: string,
	errorMessage?: string,
): ToolResultMessage {
	const stopReasonText =
		errorMessage !== undefined && errorMessage !== null && errorMessage !== "" ? `: ${errorMessage}` : ".";
	const errorText = `Tool execution was skipped because the request was ${stopReason}${stopReasonText}`;
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

/* eslint-disable no-await-in-loop */

/**
 * Execute multiple tool calls, checking for steering messages between calls if interruptMode is "immediate".
 */
export async function executeToolCalls(
	tools: AnyAgentTool[],
	message: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const toolResults: ToolResultMessage[] = [];
	const toolCalls = message.content.filter((c): c is ToolCall => c.type === "toolCall");

	for (const toolCall of toolCalls) {
		if (config.interruptMode === "immediate") {
			const steeringMessages = (await config.getSteeringMessages?.()) ?? [];
			if (steeringMessages.length > 0) {
				return { toolResults, steeringMessages };
			}
		}

		if (signal?.aborted === true) {
			toolResults.push(createAbortedToolResult(toolCall, stream, "aborted"));
			continue;
		}

		const result = await executeSingleToolCall(tools, toolCall, signal, stream, config);
		toolResults.push(result);
	}

	return { toolResults };
}

async function executeSingleToolCall(
	tools: AnyAgentTool[],
	toolCall: ToolCall,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): Promise<ToolResultMessage> {
	const tool = tools.find(t => t.name === toolCall.name);
	const { args, intent } = prepareToolArgs(toolCall, config);

	stream.push({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args, intent });

	if (!tool) {
		return handleToolNotFound(toolCall, stream);
	}

	try {
		return await performToolExecution(tool, toolCall, args, signal, stream, config);
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

function handleToolNotFound(toolCall: ToolCall, stream: EventStream<AgentEvent, AgentMessage[]>): ToolResultMessage {
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: `Error: Tool "${toolCall.name}" not found.` }],
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
): Promise<ToolResultMessage> {
	const toolCallContext: ToolCallContext = {
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		arguments: args,
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
		isError: toolResult.isError === true,
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
