/**
 * Tool wrappers for extensions.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Component } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../modes/theme/theme";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolRenderResultOptions } from "./types";

export { ExtensionToolWrapper } from "./tool-wrapper";

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool {
	declare name: string;
	declare description: string;
	declare parameters: TSchema;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: unknown, options: ToolRenderResultOptions, theme: unknown) => Component;
	renderResult?: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: unknown,
		args?: unknown,
	) => Component;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		const definition = registeredTool.definition;
		const renderCall = definition.renderCall;
		if (renderCall) {
			this.renderCall = (args, options, theme) => renderCall(args as Static<TSchema>, options, theme as Theme);
		}
		const renderResult = definition.renderResult;
		if (renderResult) {
			this.renderResult = (result, options, theme, args) =>
				renderResult(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args as Static<TSchema>,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<unknown>> {
		return this.registeredTool.definition.execute(
			toolCallId,
			params as Static<TSchema>,
			signal,
			onUpdate,
			this.runner.createContext(),
		);
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}
