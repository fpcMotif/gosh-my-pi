import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Static, TSchema } from "@sinclair/typebox";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "../../modes/theme/theme";
import { RequestCorrelator } from "./request-correlator";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";
import type { WireFrame } from "./wire/v1";

/**
 * The output callback emits any v1 wire frame. RpcHostToolBridge only
 * emits the host_tool_call / host_tool_cancel sub-types but takes the
 * full WireFrame parameter so it composes with rpc-mode's chokepoint.
 */
type RpcHostToolOutput = (frame: WireFrame) => void;

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (value === null || value === undefined || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (value === null || value === undefined || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (value === null || value === undefined || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme> implements AgentTool<
	TParams,
	unknown,
	TTheme
> {
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge) {
		this.#definition = definition;
		this.#bridge = bridge;
		applyToolProxy(definition, this);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

export class RpcHostToolBridge {
	#output: RpcHostToolOutput;
	#definitions = new Map<string, RpcHostToolDefinition>();
	#correlator = new RequestCorrelator();
	// Streaming update callbacks fire repeatedly until the final result frame,
	// so they don't fit the one-shot register/resolve pattern in #correlator.
	#updateCallbacks = new Map<string, AgentToolUpdateCallback<unknown>>();

	constructor(output: RpcHostToolOutput) {
		this.#output = output;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	setTools(tools: RpcHostToolDefinition[]): AgentTool[] {
		this.#definitions = new Map(tools.map(tool => [tool.name, tool]));
		return tools.map(tool => new RpcHostToolAdapter(tool, this));
	}

	handleResult(frame: RpcHostToolResult): boolean {
		this.#updateCallbacks.delete(frame.id);
		if (frame.isError === true) {
			const text = frame.result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			return this.#correlator.reject(frame.id, new Error(text || "Host tool execution failed"));
		}
		return this.#correlator.resolve(frame.id, frame.result);
	}

	handleUpdate(frame: RpcHostToolUpdate): boolean {
		const onUpdate = this.#updateCallbacks.get(frame.id);
		if (!onUpdate) return false;
		onUpdate(frame.partialResult);
		return true;
	}

	requestExecution(
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		const { id, promise } = this.#correlator.register<AgentToolResult<unknown>>({
			signal,
			onAbort: () => {
				// Notify host to dismiss the pending tool call.
				this.#output({
					type: "host_tool_cancel",
					id: Snowflake.next() as string,
					targetId: id,
				});
				this.#updateCallbacks.delete(id);
			},
		});

		if (onUpdate !== undefined) {
			this.#updateCallbacks.set(id, onUpdate);
		}

		this.#output({
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			arguments: args,
		});

		// Ensure update-callback cleanup happens when the promise settles
		// regardless of how (resolve, reject, or abort), without creating a
		// second promise that can reject unobserved.
		void promise.then(
			() => {
				this.#updateCallbacks.delete(id);
			},
			() => {
				this.#updateCallbacks.delete(id);
			},
		);

		// Custom abort error message — RequestCorrelator's default reason is
		// generic; preserve the prior "Host tool X was aborted" wording.
		return promise.catch(error => {
			if (signal?.aborted === true) {
				throw new Error(`Host tool "${definition.name}" was aborted`);
			}
			throw error;
		});
	}

	rejectAllPending(message: string): void {
		this.#correlator.cancelAll(message);
		this.#updateCallbacks.clear();
	}
}
