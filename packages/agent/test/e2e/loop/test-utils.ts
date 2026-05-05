/**
 * Shared helpers for Phase-C agent-loop e2e tests.
 *
 * Co-located with the test files (rather than in packages/agent/test/helpers.ts)
 * because these are Phase-C-specific and belong with the contract suite they
 * support. Each helper here exists because >=2 test files would otherwise
 * duplicate the same boilerplate.
 */
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	StopReason,
	ToolCall,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/** Subclass purely so test files can spot-check `instanceof` if they need to. */
export class MockStream extends AssistantMessageEventStream {}

export type StreamFnLike = (model: Model) => AssistantMessageEventStream;

export function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

export function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

export function passthroughConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

export function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function emptyAssistantMessage(model: Model, content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Drain all events from an agent-loop stream. */
export async function drainEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/**
 * Drain with a hard timeout. Used for hang-detection contracts where the
 * test must not block forever even on bug.
 */
export async function drainWithTimeout(
	stream: AsyncIterable<AgentEvent> & { result(): Promise<unknown> },
	timeoutMs: number,
): Promise<{ events: AgentEvent[]; iterErr?: unknown; resultErr?: unknown; timedOut: boolean }> {
	const events: AgentEvent[] = [];
	const timeout = Promise.withResolvers<"timeout">();
	const handle = setTimeout(() => timeout.resolve("timeout"), timeoutMs);

	// Attach the result() handler synchronously so a fast rejection (e.g.
	// transformContext throwing during the first turn) is captured before the
	// microtask queue can flag it as unhandled.
	let resultErr: unknown;
	const resultPromise = stream.result().catch(error => {
		resultErr = error;
	});

	let iterErr: unknown;
	const consume = (async () => {
		try {
			for await (const event of stream) events.push(event);
		} catch (error) {
			iterErr = error;
		}
		return "consumed" as const;
	})();

	const winner = await Promise.race([consume, timeout.promise]);
	clearTimeout(handle);
	if (winner === "timeout") return { events, iterErr, timedOut: true };

	await resultPromise;
	return { events, iterErr, resultErr, timedOut: false };
}

/* ── scripted-stream factories ───────────────────────────────────────── */

export type ScriptedEvent =
	| { kind: "text"; delta: string; afterMs?: number }
	| { kind: "thinking"; delta: string; afterMs?: number }
	| { kind: "toolDelta"; partialJson: string; afterMs?: number }
	| { kind: "toolDone"; toolCall: ToolCall; afterMs?: number }
	| { kind: "done"; reason?: Extract<StopReason, "stop" | "length" | "toolUse">; afterMs?: number }
	| { kind: "error"; reason?: Extract<StopReason, "aborted" | "error">; message?: string; afterMs?: number }
	| { kind: "endNoFinal"; afterMs?: number }
	| { kind: "hang" };

export function scriptedStream(events: ScriptedEvent[]): StreamFnLike {
	return (model: Model) => {
		const stream = new MockStream();
		const partial = emptyAssistantMessage(model);

		queueMicrotask(() => {
			stream.push({ type: "start", partial });
			void runScript(stream, partial, events).catch(() => {
				// scripted errors are intentional - swallow so they don't leak
			});
		});

		return stream;
	};
}

async function runScript(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	events: ScriptedEvent[],
): Promise<void> {
	for (const event of events) {
		const wait = event.kind !== "hang" ? (event.afterMs ?? 0) : Number.POSITIVE_INFINITY;
		if (wait > 0) await Bun.sleep(wait);

		switch (event.kind) {
			case "text":
				stream.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial });
				break;
			case "thinking":
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: event.delta, partial });
				break;
			case "toolDelta":
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: event.partialJson, partial });
				break;
			case "toolDone":
				if (!partial.content.some(content => content.type === "toolCall" && content.id === event.toolCall.id)) {
					partial.content.push(event.toolCall);
				}
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: event.toolCall, partial });
				break;
			case "done": {
				const reason = event.reason ?? "stop";
				const message = { ...partial, stopReason: reason };
				stream.push({ type: "done", reason, message });
				return;
			}
			case "error": {
				const reason = event.reason ?? "error";
				const errorMessage = { ...partial, stopReason: reason, errorMessage: event.message ?? "scripted error" };
				stream.push({ type: "error", reason, error: errorMessage });
				return;
			}
			case "endNoFinal":
				stream.end();
				return;
			case "hang":
				return;
		}
	}
}

/**
 * A streamFn factory that returns a different scripted stream on each call.
 * Used for multi-turn tests where the LLM's behaviour differs per turn (e.g.
 * tool error → retry → success).
 */
export function turnSequencedStream(scripts: ScriptedEvent[][]): StreamFnLike {
	let index = 0;
	return (model: Model) => {
		const events = scripts[Math.min(index, scripts.length - 1)];
		index += 1;
		const fn = scriptedStream(events);
		return fn(model);
	};
}

/** Build a tool call object suitable for emitting via toolDone. */
export function makeToolCall(name: string, args: Record<string, unknown>, id = `tc-${Math.random()}`): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

/** Sugar for "emit a tool call then `done` with toolUse" - the typical multi-turn turn-1 shape. */
export function toolCallTurn(toolName: string, args: Record<string, unknown>, id?: string): ScriptedEvent[] {
	const toolCall = makeToolCall(toolName, args, id);
	return [
		{ kind: "toolDelta", partialJson: JSON.stringify(args) },
		{ kind: "toolDone", toolCall },
		{ kind: "done", reason: "toolUse" },
	];
}

/** Sugar for "emit text then `done`". */
export function textTurn(text: string): ScriptedEvent[] {
	return [{ kind: "text", delta: text }, { kind: "done" }];
}

/* ── minimal context/config builders ──────────────────────────────────── */

export function emptyContext(): AgentContext {
	return { systemPrompt: "", messages: [], tools: [] };
}

export function basicConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model: createModel(),
		convertToLlm: passthroughConverter,
		...overrides,
	};
}

/** Re-export for test-file convenience so they don't need a separate import. */
export type { AssistantMessageEvent };
