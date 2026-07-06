/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { FileSink } from "bun";
import { isRecord, logger, ptree, readLines } from "@oh-my-pi/pi-utils";
import type { BashResult } from "../../exec/bash-executor";
import type { SessionStats } from "../../session/agent-session";
import type { CompactionResult } from "../../session/compaction";
import type {
	RpcCommand,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types";
import type { WireExtensionErrorFrameV1 } from "./wire/v1";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;

/**
 * Diagnostic frames are out-of-band notices (currently `extension_error`) that
 * are not part of the agent event stream. Hosts may surface them; they are safe
 * to ignore.
 */
export type RpcDiagnosticListener = (frame: WireExtensionErrorFrameV1) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string";
	}
	return true;
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

/**
 * Total normalizer for `extension_error` diagnostic frames. Returns null for
 * anything else, and coerces missing fields to "" so a malformed frame still
 * surfaces a typed diagnostic instead of crashing the read loop.
 */
function toWireExtensionError(value: unknown): WireExtensionErrorFrameV1 | null {
	if (!isRecord(value) || value.type !== "extension_error") {
		return null;
	}
	return {
		type: "extension_error",
		extensionPath: typeof value.extensionPath === "string" ? value.extensionPath : "",
		event: typeof value.event === "string" ? value.event : "",
		error: typeof value.error === "string" ? value.error : "",
	};
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	#process: ptree.ChildProcess | null = null;
	#eventListeners: RpcEventListener[] = [];
	#diagnosticListeners: RpcDiagnosticListener[] = [];
	#pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#abortController = new AbortController();

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.#process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		// Fields are typed `string | undefined`, so a single truthiness check
		// covers both undefined and empty-string.
		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.#process = ptree.spawn(["bun", cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
		});

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;

		// Process lines in background, intercepting the ready signal. Read raw
		// lines and parse each individually so a single malformed frame from the
		// agent is skipped (logged) instead of throwing out of the loop and
		// permanently freezing the transport — a post-ready JSONL syntax error
		// would otherwise stop event correlation and hang every later request.
		const decoder = new TextDecoder();
		const lines = readLines(this.#process.stdout, this.#abortController.signal);
		void (async () => {
			for await (const lineBytes of lines) {
				const raw = decoder.decode(lineBytes).trim();
				if (raw.length === 0) continue;
				let line: unknown;
				try {
					line = JSON.parse(raw);
				} catch (error) {
					logger.warn("RpcClient: skipping malformed frame from agent", {
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}
				if (!readySettled && isRecord(line) && line.type === "ready") {
					readySettled = true;
					readyResolve();
					continue;
				}
				this.#handleLine(line);
			}
			// Stream ended without ready signal — process exited
			if (!readySettled) {
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${this.#process?.peekStderr() ?? ""}`));
			}
		})().catch((error: Error) => {
			if (!readySettled) {
				readySettled = true;
				readyReject(error);
				return;
			}
			// Post-ready transport failure: the read loop has stopped, so no
			// further responses will ever be correlated. Reject in-flight
			// requests instead of leaving callers to hang until their timeout.
			logger.error("RpcClient: read loop terminated after ready", { error: error.message });
			this.#rejectAllPending(new Error(`RPC transport failed: ${error.message}`));
		});

		// Also race against process exit (in case stdout closes before we read it)
		void this.#process.exited.then((exitCode: number) => {
			if (!readySettled) {
				readySettled = true;
				readyReject(
					new Error(`Agent process exited with code ${exitCode}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
				);
			}
		});

		// Timeout to prevent hanging forever
		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			readyReject(
				new Error(`Timeout waiting for agent to become ready. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		try {
			await readyPromise;
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop() {
		if (!this.#process) return;

		this.#process.kill();
		this.#abortController.abort();
		this.#process = null;
		// Reject — not just drop — in-flight requests so awaiting callers settle
		// deterministically instead of hanging until their 30s (unref'd) timeout.
		this.#rejectAllPending(new Error("RPC client stopped"));
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort();
		}
		this.#pendingHostToolCalls.clear();
	}

	/** Reject every in-flight request and clear the pending map. */
	#rejectAllPending(error: Error): void {
		for (const pending of this.#pendingRequests.values()) {
			pending.reject(error);
		}
		this.#pendingRequests.clear();
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		try {
			this.stop();
		} catch {
			// Ignore cleanup errors
		}
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to out-of-band diagnostic frames (currently `extension_error`).
	 * These are not agent events; hosts may surface them or ignore them.
	 */
	onDiagnostic(listener: RpcDiagnosticListener): () => void {
		this.#diagnosticListeners.push(listener);
		return () => {
			const index = this.#diagnosticListeners.indexOf(listener);
			if (index !== -1) {
				this.#diagnosticListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: Model;
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	/**
	 * Get list of available models. The wire carries full `Model` objects
	 * (rpc-types.ts get_available_models response), so type them as such rather
	 * than the lossy `ModelInfo` projection.
	 */
	async getAvailableModels(): Promise<Model[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: Model[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		// Diagnostic frames (extension_error) are not agent events and must not be
		// dropped silently; surface them to diagnostic listeners (gap G22).
		const extensionError = toWireExtensionError(data);
		if (extensionError) {
			this.#emitDiagnostic(extensionError);
			return;
		}

		if (!isAgentEvent(data)) return;

		// Otherwise it's an event
		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#emitDiagnostic(frame: WireExtensionErrorFrameV1): void {
		for (const listener of this.#diagnosticListeners) {
			listener(frame);
		}
	}

	#send(command: RpcCommandBody): Promise<RpcResponse> {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(30000, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		this.#writeFrame(fullCommand, err => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		});
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(frame: RpcCommand | RpcHostToolResult | RpcHostToolUpdate, onError?: (error: Error) => void): void {
		const stdin = this.#process?.stdin as FileSink | undefined;
		if (!stdin) {
			// Transport is gone (process stopped between a host_tool_call arriving
			// and this detached handler running). Surface to onError when the
			// caller can recover (#send rejects the pending request); otherwise
			// drop quietly — a `void`-ed host-tool reply must not become an
			// unhandled rejection.
			const error = new Error("Client not started");
			if (onError) {
				onError(error);
			} else {
				logger.debug("RpcClient: dropping frame, transport is gone", {
					type: (frame as { type?: string }).type,
				});
			}
			return;
		}
		void stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (flushResult instanceof Promise) {
			flushResult.catch((error: Error) => {
				onError?.(error);
			});
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
