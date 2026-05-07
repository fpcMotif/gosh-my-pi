/** Agent class that uses the agent-loop directly.
 * No transport abstraction - calls streamSimple via the loop.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	Effort,
	getBundledModel,
	type ImageContent,
	type Message,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type ThinkingBudgets,
	type ToolChoice,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { agentLoop, agentLoopContinue } from "./agent-loop";
import { classifyAssistantError } from "./error-kind";
import {
	AgentBusyError,
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentListener,
	type AgentMessage,
	type AgentOptions,
	type AgentPromptOptions,
	type AgentState,
	type AnyAgentTool,
} from "./types";
import { handleTurnEnd, handleToolExecutionStart, handleToolExecutionEnd } from "./agent/loop-handlers";
import { emitCursorSplitAssistantMessage } from "./agent/cursor-utils";
import { preparePromptMessages, preparePromptOptions } from "./agent/prompt-utils";

/**
 * Default convertToLlm: Keep only LLM-compatible messages, convert attachments.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

function refreshToolChoiceForActiveTools(
	toolChoice: ToolChoice | undefined,
	tools: AgentContext["tools"] = [],
): ToolChoice | undefined {
	if (toolChoice === undefined || toolChoice === null || typeof toolChoice === "string") {
		return toolChoice;
	}

	const toolName =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: (toolChoice as { name: string }).name;

	return tools.some(tool => tool.name === toolName) ? toolChoice : undefined;
}

export class Agent {
	#state: AgentState;
	#listeners = new Set<AgentListener>();
	#steeringQueue: AgentMessage[] = [];
	#followUpQueue: AgentMessage[] = [];
	#runningPrompt?: Promise<void>;
	#resolveRunningPrompt?: () => void;
	#abortController?: AbortController;

	#opts: AgentOptions;
	#onAssistantMessageEvent?: (event: AssistantMessageEvent) => void;

	// Cursor-specific buffering state
	#cursorToolResultBuffer: Array<{ toolResult: ToolResultMessage; textLengthAtCall: number }> = [];

	constructor(options: AgentOptions = {}) {
		this.#opts = options;
		this.#onAssistantMessageEvent = options.onAssistantMessageEvent;
		this.#state = {
			messages: options.initialState?.messages ?? [],
			systemPrompt: options.initialState?.systemPrompt ?? "You are a helpful assistant.",
			tools: options.initialState?.tools ?? [],
			// Default to a known-bundled model so `state.model` is always defined; production callers
			// (packages/coding-agent/src/sdk.ts) always pass an explicit model so this default is
			// inert in real use, but tests rely on it.
			model: options.initialState?.model ?? getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
			thinkingLevel: options.initialState?.thinkingLevel ?? Effort.Medium,
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Set<string>(),
			error: undefined,
		};
	}

	setAssistantMessageEventInterceptor(fn: ((event: AssistantMessageEvent) => void) | undefined): void {
		this.#onAssistantMessageEvent = fn;
	}

	emitExternalEvent(event: AgentEvent) {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.#state.streamMessage = event.message;
				break;
			case "message_end":
				this.#handleMessageEnd(event.message);
				break;
			case "agent_end":
				this.#state.isStreaming = false;
				this.#state.streamMessage = null;
				break;
		}
		this.#emit(event);
	}

	get state(): AgentState {
		return { ...this.#state };
	}

	get messages(): AgentMessage[] {
		return this.#state.messages;
	}

	get model(): Model | undefined {
		return this.#state.model;
	}

	set model(model: Model | undefined) {
		this.#state.model = model as unknown as Model;
	}

	setModel(model: Model | undefined): void {
		this.#state.model = model as unknown as Model;
	}

	get systemPrompt(): string {
		return this.#state.systemPrompt;
	}

	set systemPrompt(prompt: string) {
		this.#state.systemPrompt = prompt;
	}

	setSystemPrompt(prompt: string): void {
		this.#state.systemPrompt = prompt;
	}

	get tools(): AnyAgentTool[] {
		return this.#state.tools;
	}

	set tools(tools: AnyAgentTool[]) {
		this.#state.tools = tools;
	}

	setTools(tools: AnyAgentTool[]): void {
		this.#state.tools = tools;
	}

	get thinkingLevel(): Effort {
		return this.#state.thinkingLevel ?? Effort.Medium;
	}

	set thinkingLevel(level: Effort) {
		this.#state.thinkingLevel = level;
	}

	setThinkingLevel(level: Effort): void {
		this.#state.thinkingLevel = level;
	}

	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this.#opts.thinkingBudgets;
	}

	set thinkingBudgets(budgets: ThinkingBudgets | undefined) {
		this.#opts.thinkingBudgets = budgets;
	}

	clearMessages(): void {
		this.#state.messages = [];
	}

	get sessionId(): string | undefined {
		return this.#opts.sessionId;
	}

	set sessionId(sessionId: string | undefined) {
		this.#opts.sessionId = sessionId;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.#opts.serviceTier;
	}

	set serviceTier(serviceTier: ServiceTier | undefined) {
		this.#opts.serviceTier = serviceTier;
	}

	get providerSessionState(): Map<string, ProviderSessionState> | undefined {
		return this.#opts.providerSessionState;
	}

	set providerSessionState(state: Map<string, ProviderSessionState> | undefined) {
		this.#opts.providerSessionState = state;
	}

	/** Steering mode: how queued steering messages are drained. Defaults to "one-at-a-time". */
	getSteeringMode(): "all" | "one-at-a-time" {
		return this.#opts.steeringMode ?? "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.#opts.steeringMode = mode;
	}

	/** Follow-up mode: how queued follow-up messages are drained. Defaults to "all". */
	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.#opts.followUpMode ?? "all";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.#opts.followUpMode = mode;
	}

	/** Interrupt mode: when steering messages interrupt tool execution. Defaults to "immediate". */
	getInterruptMode(): "immediate" | "wait" {
		return this.#opts.interruptMode ?? "immediate";
	}

	setInterruptMode(mode: "immediate" | "wait"): void {
		this.#opts.interruptMode = mode;
	}

	subscribe(listener: AgentListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Append a message to the agent's history.
	 */
	appendMessage(message: AgentMessage) {
		this.#state.messages.push(message);
	}

	/**
	 * Replace the agent's entire message history.
	 */
	replaceMessages(messages: AgentMessage[]) {
		this.#state.messages = [...messages];
	}

	/**
	 * Add a steering message (injected during current or next turn).
	 * Thread-safe: can be called while agent is streaming.
	 */
	steer(m: AgentMessage) {
		this.#steeringQueue.push(m);
	}

	/**
	 * Add a follow-up message (starts a new turn after current turn completes).
	 * Thread-safe: can be called while agent is streaming.
	 */
	followUp(m: AgentMessage) {
		this.#followUpQueue.push(m);
	}

	/**
	 * Check whether there are any queued steering or follow-up messages.
	 */
	hasQueuedMessages(): boolean {
		return this.#steeringQueue.length > 0 || this.#followUpQueue.length > 0;
	}

	/**
	 * Clear all queued steering and follow-up messages.
	 */
	clearAllQueues(): void {
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	/**
	 * Pop the last steering message (LIFO). Returns undefined if empty.
	 */
	popLastSteer(): AgentMessage | undefined {
		return this.#steeringQueue.pop();
	}

	/**
	 * Pop the last follow-up message (LIFO). Returns undefined if empty.
	 */
	popLastFollowUp(): AgentMessage | undefined {
		return this.#followUpQueue.pop();
	}

	/**
	 * Abort the current request.
	 */
	abort() {
		this.#abortController?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.#runningPrompt ?? Promise.resolve();
	}

	reset() {
		this.#state.messages = [];
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#state.error = undefined;
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	/** Send a prompt with an AgentMessage */
	async prompt(message: AgentMessage | AgentMessage[], options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, images?: ImageContent[], options?: AgentPromptOptions): Promise<void>;
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	) {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		if (this.#state.model === null || this.#state.model === undefined) throw new Error("No model configured");

		const msgs = preparePromptMessages(input, imagesOrOptions);
		const promptOptions = preparePromptOptions(input, imagesOrOptions, options);

		await this.#runLoop(msgs, promptOptions);
	}

	/**
	 * Continue from current context (used for retries and resuming queued messages).
	 */
	async continue() {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const messages = this.#state.messages;
		if (messages.length === 0) throw new Error("No messages to continue from");

		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this.#dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				// In "all" mode the dequeue drained every queued message, so further polls would
				// be wasted. In "one-at-a-time" (the default), only one was dequeued, so let the
				// loop keep polling so the next steering message gets its own assistant response.
				const skipInitialSteeringPoll = (this.#opts.steeringMode ?? "one-at-a-time") === "all";
				await this.#runLoop(queuedSteering, { skipInitialSteeringPoll });
				return;
			}

			const queuedFollowUp = this.#dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this.#runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.#runLoop(undefined);
	}

	/**
	 * Run the agent loop.
	 * If messages are provided, starts a new conversation turn with those messages.
	 * Otherwise, continues from existing context.
	 */
	async #runLoop(messages?: AgentMessage[], options?: AgentPromptOptions & { skipInitialSteeringPoll?: boolean }) {
		const model = this.#state.model;
		if (model === null || model === undefined) throw new Error("No model configured");

		const { promise, resolve } = Promise.withResolvers<void>();
		this.#runningPrompt = promise;
		this.#resolveRunningPrompt = resolve;

		this.#abortController = new AbortController();
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;
		this.#cursorToolResultBuffer = [];

		const config = this.#createLoopConfig(model, options);
		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(messages, this.#createLoopContext(), config, this.#abortController.signal, this.#opts.streamFn)
				: agentLoopContinue(this.#createLoopContext(), config, this.#abortController.signal, this.#opts.streamFn);

			for await (const event of stream) {
				partial = this.#handleLoopEvent(event);
				this.#emit(event);
			}

			this.#handleRemainingPartial(partial);
		} catch (error: unknown) {
			this.#handleLoopError(error, model);
		} finally {
			this.#cleanupLoop();
		}
	}

	#createLoopContext(): AgentContext {
		return {
			systemPrompt: this.#state.systemPrompt,
			messages: this.#state.messages.slice(),
			tools: this.#state.tools,
		};
	}

	#createLoopConfig(
		model: Model,
		options?: AgentPromptOptions & { skipInitialSteeringPoll?: boolean },
	): AgentLoopConfig {
		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;
		const getToolChoice = () =>
			this.#opts.getToolChoice?.() ?? refreshToolChoiceForActiveTools(options?.toolChoice, this.#state.tools);

		return {
			model,
			reasoning: this.#state.thinkingLevel,
			temperature: this.#opts.temperature,
			topP: this.#opts.topP,
			topK: this.#opts.topK,
			minP: this.#opts.minP,
			presencePenalty: this.#opts.presencePenalty,
			repetitionPenalty: this.#opts.repetitionPenalty,
			serviceTier: this.#opts.serviceTier,
			interruptMode: this.#opts.interruptMode ?? "immediate",
			sessionId: this.#opts.sessionId,
			providerSessionState: this.#opts.providerSessionState,
			thinkingBudgets: this.#opts.thinkingBudgets,
			maxRetryDelayMs: this.#opts.maxRetryDelayMs,
			kimiApiFormat: this.#opts.kimiApiFormat,
			preferWebsockets: this.#opts.preferWebsockets,
			convertToLlm: this.#opts.convertToLlm ?? defaultConvertToLlm,
			transformContext: this.#opts.transformContext,
			onPayload: this.#opts.onPayload,
			onResponse: this.#opts.onResponse,
			getApiKey: this.#opts.getApiKey,
			getToolContext: this.#opts.getToolContext,
			syncContextBeforeModelCall: async context => {
				if (this.#listeners.size > 0) {
					await Bun.sleep(0);
				}
				context.systemPrompt = this.#state.systemPrompt;
				context.tools = this.#state.tools;
			},
			transformToolCallArguments: this.#opts.transformToolCallArguments,
			intentTracing: this.#opts.intentTracing,
			onAssistantMessageEvent: this.#onAssistantMessageEvent,
			getToolChoice,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.#dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => this.#dequeueFollowUpMessages(),
		};
	}

	#handleLoopEvent(event: AgentEvent): AgentMessage | null {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.#state.streamMessage = event.message;
				return event.message;

			case "message_end":
				this.#handleMessageEnd(event.message);
				return null;

			case "tool_execution_start":
				this.#state.pendingToolCalls = handleToolExecutionStart(event, this.#state.pendingToolCalls);
				break;

			case "tool_execution_end":
				this.#state.pendingToolCalls = handleToolExecutionEnd(event, this.#state.pendingToolCalls);
				break;

			case "turn_end":
				handleTurnEnd(event, err => {
					this.#state.error = err;
				});
				break;

			case "agent_end":
				this.#state.isStreaming = false;
				this.#state.streamMessage = null;
				break;
		}
		return this.#state.streamMessage;
	}

	#handleMessageEnd(message: AgentMessage) {
		if (message.role === "assistant" && this.#cursorToolResultBuffer.length > 0) {
			emitCursorSplitAssistantMessage(
				message as AssistantMessage,
				this.#cursorToolResultBuffer,
				m => this.appendMessage(m),
				e => this.#emit(e),
				() => {
					this.#state.streamMessage = null;
				},
			);
		} else {
			this.#state.streamMessage = null;
			this.appendMessage(message);
		}
	}

	#handleRemainingPartial(partial: AgentMessage | null) {
		if (partial && partial.role === "assistant" && partial.content.length > 0) {
			const hasContent = partial.content.some(
				c =>
					(c.type === "thinking" && c.thinking.trim().length > 0) ||
					(c.type === "text" && c.text.trim().length > 0) ||
					(c.type === "toolCall" && c.name.trim().length > 0),
			);
			if (hasContent) {
				this.appendMessage(partial);
			} else if (this.#abortController?.signal.aborted === true) {
				throw new Error("Request was aborted");
			}
		}
	}

	#handleLoopError(error: unknown, model: Model) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorMsg: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
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
			stopReason: this.#abortController?.signal.aborted === true ? "aborted" : "error",
			errorMessage,
			timestamp: Date.now(),
		} as AgentMessage;

		this.appendMessage(errorMsg);
		this.#state.error = errorMessage;
		this.#emit({
			type: "agent_end",
			messages: [errorMsg],
			errorKind: classifyAssistantError(errorMsg as AssistantMessage, model.contextWindow),
		});
	}

	#cleanupLoop() {
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#abortController = undefined;
		this.#resolveRunningPrompt?.();
		this.#runningPrompt = undefined;
		this.#resolveRunningPrompt = undefined;
	}

	#emit(e: AgentEvent) {
		for (const listener of this.#listeners) {
			listener(e);
		}
	}

	/**
	 * Drain a message queue: take all when mode is "all", otherwise one at a time.
	 * Returns `[]` when the queue is empty.
	 */
	#drainQueue(queue: AgentMessage[], mode: "all" | "one-at-a-time" | undefined): AgentMessage[] {
		if (mode === "all") return queue.splice(0);
		// Default and "one-at-a-time" both pop a single message, keeping caller invariants tight
		// (one assistant response per dequeued user message).
		const msg = queue.shift();
		return msg !== undefined ? [msg] : [];
	}

	#dequeueSteeringMessages(): AgentMessage[] {
		// Steering defaults to one-at-a-time so each interruption gets its own assistant response.
		return this.#drainQueue(this.#steeringQueue, this.#opts.steeringMode);
	}

	#dequeueFollowUpMessages(): AgentMessage[] {
		// Follow-up defaults to "all" so a batch of queued messages is processed in a single turn.
		return this.#drainQueue(this.#followUpQueue, this.#opts.followUpMode ?? "all");
	}
}
