import { EventStream, type AssistantMessage, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Effect } from "@oh-my-pi/pi-utils/effect";
import { type AgentErrorKind, classifyAssistantError } from "./error-kind";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types";
import { createAbortedToolResult, executeToolCalls, INTENT_FIELD } from "./agent-loop/execution";
import { streamAssistantResponse } from "./agent-loop/streaming";

export { INTENT_FIELD };

/* eslint-disable no-await-in-loop */

function lastAssistantErrorKind(messages: AgentMessage[], contextWindow?: number): AgentErrorKind | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return classifyAssistantError(message, contextWindow);
		}
	}
	return undefined;
}

interface RunLoopState {
	readonly firstTurn: boolean;
	readonly pendingMessages: AgentMessage[];
	readonly done: boolean;
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 *
 * The outer iteration is expressed as `Effect.whileLoop` so termination is
 * driven by the state predicate rather than an unbounded-loop + early return;
 * this keeps interrupt semantics consistent with the rest of the run surface
 * (see `./run/agent-run`).
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
	initialMessages: AgentMessage[] = [],
): Promise<void> {
	stream.push({ type: "agent_start" });
	// When the caller already supplied initialMessages (e.g. an explicit prompt or a single
	// dequeued steering message in one-at-a-time mode), don't drain the steering queue here.
	// the inner loop polls on subsequent iterations so each queued message gets its own turn.
	const steeringMessages = initialMessages.length > 0 ? [] : ((await config.getSteeringMessages?.()) ?? []);
	const stateRef: { current: RunLoopState } = {
		current: {
			firstTurn: true,
			pendingMessages: [...initialMessages, ...steeringMessages],
			done: false,
		},
	};

	await Effect.runPromise(
		Effect.whileLoop({
			while: () => !stateRef.current.done,
			body: () =>
				Effect.promise(() =>
					stepRunLoop(stateRef.current, currentContext, newMessages, config, signal, stream, streamFn),
				),
			step: (next: RunLoopState) => {
				stateRef.current = next;
			},
		}),
	);

	stream.push({
		type: "agent_end",
		messages: newMessages,
		errorKind: lastAssistantErrorKind(newMessages, config.model?.contextWindow),
	});
	stream.end(newMessages);
}

async function stepRunLoop(
	state: RunLoopState,
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn: StreamFn | undefined,
): Promise<RunLoopState> {
	const result = await processLoopTurn(
		currentContext,
		newMessages,
		config,
		signal,
		stream,
		streamFn,
		state.firstTurn,
		state.pendingMessages,
	);
	if (result.terminated) {
		return { firstTurn: false, pendingMessages: [], done: true };
	}

	const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
	return {
		firstTurn: false,
		pendingMessages: followUpMessages.length > 0 ? followUpMessages : result.nextPendingMessages,
		done: followUpMessages.length === 0,
	};
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
		}
		stream.push({ type: "turn_start" });

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
			stream.push({ type: "message_start", message: result });
			stream.push({ type: "message_end", message: result });
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

	return executeToolCalls(currentContext.tools ?? [], message, signal, stream, config);
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
		stream.push({ type: "message_start", message: result });
		stream.push({ type: "message_end", message: result });
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

	// Pass `messages` as initialMessages so the prompt actually reaches the loop. Without this
	// the loop sees only context.messages and silently drops the new user prompt, the bug that
	// caused the local-e2e tests' user message to disappear from the persisted branch.
	void runLoop(context, newMessages, config, signal, stream, streamFn, messages);

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
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	const stream = new EventStream<AgentEvent, AgentMessage[]>();
	const newMessages: AgentMessage[] = [];

	void runLoop(context, newMessages, config, signal, stream, streamFn);

	return stream;
}
