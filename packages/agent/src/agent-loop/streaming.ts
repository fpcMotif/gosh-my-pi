import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	streamSimple,
	transformMessages,
	type Tool,
} from "@oh-my-pi/pi-ai";
import type { EventStream } from "@oh-my-pi/pi-ai";
import { Effect } from "@oh-my-pi/pi-utils/effect";
import { classifyAssistantError } from "../error-kind";
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
		try {
			messages = await config.transformContext(messages, signal);
		} catch (error) {
			// Compaction failure: synthesise a terminal error message instead
			// of propagating an unhandled rejection. The agent loop's
			// checkTerminalResponse will see stopReason "error" and finalize
			// the turn cleanly.
			const errorMessage = error instanceof Error ? error.message : String(error);
			return finishPartialMessage(
				buildTerminalStreamMessage(config, null, `Context compaction failed: ${errorMessage}`),
				false,
				context,
				stream,
				config,
			);
		}
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

interface StreamPumpState {
	readonly partialMessage: AssistantMessage | null;
	readonly addedPartial: boolean;
	readonly terminal: AssistantMessage | null;
	readonly aborted: boolean;
	readonly streamDone: boolean;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted;
}

async function processAssistantStream(
	response: AsyncIterable<AssistantMessageEvent>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<AssistantMessage> {
	const iterator = response[Symbol.asyncIterator]();
	const stateRef: { current: StreamPumpState } = {
		current: {
			partialMessage: null,
			addedPartial: false,
			terminal: null,
			aborted: false,
			streamDone: false,
		},
	};

	// Drive the iterator drain through `Effect.whileLoop`. The loop body races
	// `iterator.next()` against the abort signal so a hung provider still
	// terminates within bounded time; `Effect.catchAll` maps an iterator throw
	// onto a terminal error frame so the outer agent loop sees a clean
	// stopReason rather than an unhandled rejection.
	await Effect.runPromise(
		Effect.whileLoop({
			while: () => !stateRef.current.streamDone && stateRef.current.terminal === null && !stateRef.current.aborted,
			body: () =>
				Effect.tryPromise({
					try: () => stepIteratorPump(iterator, signal, context, stream, stateRef.current),
					catch: error => error,
				}),
			step: (next: StreamPumpState) => {
				stateRef.current = next;
			},
		}).pipe(
			Effect.catch(error =>
				Effect.sync(() => {
					stateRef.current = {
						...stateRef.current,
						terminal: buildTerminalStreamMessage(
							config,
							stateRef.current.partialMessage,
							`Provider stream failed: ${error instanceof Error ? error.message : String(error)}`,
						),
						streamDone: true,
					};
				}),
			),
		),
	);

	const final = stateRef.current;
	if (final.aborted) {
		return handleAbortedStream(config, final.partialMessage, final.addedPartial, context, stream);
	}
	if (final.terminal !== null) {
		return finishPartialMessage(final.terminal, final.addedPartial, context, stream, config);
	}

	// Stream iterator returned without emitting `done` or `error`. Treat as
	// an error so the loop terminates cleanly via checkTerminalResponse.
	return finishPartialMessage(
		buildTerminalStreamMessage(config, final.partialMessage, "Provider stream ended without done or error event"),
		final.addedPartial,
		context,
		stream,
		config,
	);
}

async function stepIteratorPump(
	iterator: AsyncIterator<AssistantMessageEvent>,
	signal: AbortSignal | undefined,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	state: StreamPumpState,
): Promise<StreamPumpState> {
	if (isSignalAborted(signal)) {
		return { ...state, aborted: true };
	}

	const result = await raceWithAbort(iterator.next(), signal);

	if (isSignalAborted(signal)) {
		return { ...state, aborted: true };
	}
	if (result.done) {
		return { ...state, streamDone: true };
	}

	const event = result.value;
	switch (event.type) {
		case "start":
			return { ...state, partialMessage: event.partial };

		case "done":
			return { ...state, terminal: event.message };

		case "error":
			return { ...state, terminal: event.error };

		default:
			if (state.partialMessage) {
				let addedPartial = state.addedPartial;
				if (!addedPartial) {
					context.messages.push(state.partialMessage);
					stream.push({ type: "message_start", message: state.partialMessage });
					addedPartial = true;
				}
				stream.push({ type: "message_update", message: state.partialMessage, assistantMessageEvent: event });
				return { ...state, addedPartial };
			}
			return state;
	}
}

/**
 * Await `next` but resolve early as `{done: true}` when `signal` aborts.
 * Used to break out of provider streams that don't emit on abort.
 *
 * Promise-shell wrapper around the abort race; consumers stay Promise-typed
 * while the surrounding pump is driven by `Effect.iterate`.
 */
async function raceWithAbort<T>(
	next: Promise<IteratorResult<T>>,
	signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
	if (!signal) return next;
	if (isSignalAborted(signal)) return { done: true, value: undefined as never };

	const { promise: abortPromise, resolve } = Promise.withResolvers<IteratorResult<T>>();
	const onAbort = (): void => resolve({ done: true, value: undefined as never });
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([next, abortPromise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function finishPartialMessage(
	message: AssistantMessage,
	addedPartial: boolean,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
): AssistantMessage {
	if (addedPartial) {
		context.messages[context.messages.length - 1] = message;
	} else {
		context.messages.push(message);
		stream.push({ type: "message_start", message: { ...message } });
	}
	stream.push({
		type: "message_end",
		message,
		errorKind: classifyAssistantError(message, config.model?.contextWindow),
	});
	return message;
}

function handleAbortedStream(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): AssistantMessage {
	return finishPartialMessage(
		buildTerminalStreamMessage(config, partialMessage, "Request was aborted", "aborted"),
		addedPartial,
		context,
		stream,
		config,
	);
}

/**
 * Construct a terminal AssistantMessage for compaction failures, iterator
 * throws, missing-final-event, and aborts. Centralises the shape so the four
 * paths can't drift against each other.
 */
function buildTerminalStreamMessage(
	config: AgentLoopConfig,
	partialMessage: AssistantMessage | null,
	errorMessage: string,
	stopReason: Extract<AssistantMessage["stopReason"], "aborted" | "error"> = "error",
): AssistantMessage {
	if (partialMessage) {
		return { ...partialMessage, stopReason, errorMessage };
	}
	return {
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function normalizeTools(tools: AnyAgentTool[], tracing: boolean): Tool[] {
	return tools.map(t => {
		const tool: Tool = {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
			strict: t.strict,
		};

		if (tracing) {
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
