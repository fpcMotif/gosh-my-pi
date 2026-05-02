/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { ToolCallEventResult } from "./types";

interface RestartableTool {
	restartForModeChange?: () => Promise<void>;
}

function asRestartableTool(tool: object): RestartableTool {
	return tool as RestartableTool;
}

async function emitToolCallEvent<TParameters extends TSchema>(
	runner: ExtensionRunner,
	toolName: string,
	toolCallId: string,
	params: Static<TParameters>,
): Promise<void> {
	if (!runner.hasHandlers("tool_call")) return;

	try {
		const callResult = (await runner.emitToolCall({
			type: "tool_call",
			toolName,
			toolCallId,
			input: params as Record<string, unknown>,
		})) as ToolCallEventResult | undefined;

		if (callResult?.block === true) {
			const reason = callResult.reason ?? "Tool execution was blocked by an extension";
			throw new Error(reason);
		}
	} catch (error) {
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(`Extension failed, blocking execution: ${String(error)}`);
	}
}

interface ExecutionOutcome<TDetails> {
	result: AgentToolResult<TDetails>;
	executionError: Error | undefined;
}

async function runToolExecution<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	toolCallId: string,
	params: Static<TParameters>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<TDetails, TParameters> | undefined,
	context: AgentToolContext | undefined,
): Promise<ExecutionOutcome<TDetails>> {
	try {
		const result = await tool.execute(toolCallId, params, signal, onUpdate, context);
		return { result, executionError: undefined };
	} catch (error) {
		const executionError = error instanceof Error ? error : new Error(String(error));
		return {
			result: {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			},
			executionError,
		};
	}
}

function applyResultEventOverride<TDetails>(
	resultResult: { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean },
	outcome: ExecutionOutcome<TDetails>,
): AgentToolResult<TDetails> {
	const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? outcome.result.content;
	const modifiedDetails = (resultResult.details ?? outcome.result.details) as TDetails;

	// Extension can override error status
	if (resultResult.isError === true && outcome.executionError === undefined) {
		// Extension marks a successful result as error
		const textBlocks = (modifiedContent ?? []).filter((c): c is TextContent => c.type === "text");
		const errorText = textBlocks.map(t => t.text).join("\n") || "Tool result marked as error by extension";
		throw new Error(errorText);
	}
	if (resultResult.isError === false && outcome.executionError) {
		// Extension clears the error - return success
		return { content: modifiedContent, details: modifiedDetails };
	}

	// Error status unchanged, but content/details may be modified
	if (outcome.executionError) {
		throw outcome.executionError;
	}
	return { content: modifiedContent, details: modifiedDetails };
}

export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown> implements AgentTool<
	TParameters,
	TDetails
> {
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = asRestartableTool(this.tool);
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails>> {
		// Emit tool_call event - extensions can block execution
		await emitToolCallEvent(this.runner, this.tool.name, toolCallId, params);

		// Execute the actual tool
		const outcome = await runToolExecution(this.tool, toolCallId, params, signal, onUpdate, context);

		// Emit tool_result event - extensions can modify the result and error status
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: params as Record<string, unknown>,
				content: outcome.result.content,
				details: outcome.result.details,
				isError: outcome.executionError !== undefined,
			});

			if (resultResult) {
				return applyResultEventOverride(resultResult, outcome);
			}
		}

		// No extension modification
		if (outcome.executionError) {
			throw outcome.executionError;
		}
		return outcome.result;
	}
}
