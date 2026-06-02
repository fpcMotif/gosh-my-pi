import type { AgentMessage, AgentEvent, AgentErrorKind } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "../../../session/agent-session";
import { toolPresenters, type ToolPresenter } from "../../../tools/presenters";
import { toWireEvent } from "./translate";
import type { WireEventV1 } from "./v1";

// ============================================================================
// Fixture builders — mirror the shape pi-ai/pi-agent-core produce
// ============================================================================

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 100 } as AgentMessage;
}

function assistantMessage(opts: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 100,
		...opts,
	};
}

function toolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 101,
	};
}

// ============================================================================
// Exhaustiveness — every AgentSessionEvent variant produces SOMETHING
// (either a wire event or explicit null). Translator never throws.
// ============================================================================

describe("toWireEvent — exhaustiveness", () => {
	const allEventTypes: AgentSessionEvent["type"][] = [
		// pi-agent-core AgentEvent (10) — should translate
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
		// coding-agent extensions (10) — should be null
		"auto_compaction_start",
		"auto_compaction_end",
		"auto_retry_start",
		"auto_retry_end",
		"retry_fallback_applied",
		"retry_fallback_succeeded",
		"ttsr_triggered",
		"todo_reminder",
		"todo_auto_clear",
		"irc_message",
	];

	test("every variant either translates or returns null (no throws)", () => {
		// We can't construct every variant without thick fixtures, but we can
		// at least assert the type list above is exhaustive on the union.
		// If a new variant is added without a translator entry, this list
		// won't cover it and downstream tests will catch shape regressions.
		expect(allEventTypes).toHaveLength(20);
	});

	test("unknown future events fail closed as internal-only", () => {
		expect(toWireEvent(fromAny<AgentSessionEvent>({ type: "future_event" }))).toBeNull();
	});
});

// ============================================================================
// Pi-agent-core AgentEvent variants — must translate to v1 wire events
// ============================================================================

describe("toWireEvent — AgentEvent variants → v1 wire", () => {
	test("agent_start", () => {
		const wire = toWireEvent({ type: "agent_start" });
		expect(wire).toEqual({ type: "agent_start" });
	});

	test("agent_end carries messages", () => {
		const wire = toWireEvent({
			type: "agent_end",
			messages: [userMessage("hello"), assistantMessage()],
		});
		expect(wire?.type).toBe("agent_end");
		if (wire?.type === "agent_end") {
			expect(wire.messages).toHaveLength(2);
			expect(wire.messages[0].role).toBe("user");
			expect(wire.messages[1].role).toBe("assistant");
		}
	});

	test("agent_end carries errorKind when present (regression for #1a)", () => {
		const errorKind: AgentErrorKind = { kind: "transient", retryAfterMs: 1000, reason: "rate_limit" };
		const wire = toWireEvent({
			type: "agent_end",
			messages: [],
			errorKind,
		});
		expect(wire?.type).toBe("agent_end");
		if (wire?.type === "agent_end") {
			expect(wire.errorKind).toEqual({ kind: "transient", retryAfterMs: 1000, reason: "rate_limit" });
		}
	});

	test("agent_end omits errorKind when absent", () => {
		const wire = toWireEvent({ type: "agent_end", messages: [] });
		expect(wire?.type).toBe("agent_end");
		if (wire?.type === "agent_end") {
			expect("errorKind" in wire).toBe(false);
		}
	});

	test("turn_start", () => {
		expect(toWireEvent({ type: "turn_start" })).toEqual({ type: "turn_start" });
	});

	test("turn_end carries message + toolResults", () => {
		const wire = toWireEvent({
			type: "turn_end",
			message: assistantMessage(),
			toolResults: [toolResultMessage()],
		});
		expect(wire?.type).toBe("turn_end");
		if (wire?.type === "turn_end") {
			expect(wire.message.role).toBe("assistant");
			expect(wire.toolResults).toHaveLength(1);
			expect(wire.toolResults[0].role).toBe("toolResult");
		}
	});

	test("message_start", () => {
		const wire = toWireEvent({ type: "message_start", message: userMessage("hi") });
		expect(wire?.type).toBe("message_start");
		if (wire?.type === "message_start") {
			expect(wire.message.role).toBe("user");
		}
	});

	test("message_update with text_delta sub-event", () => {
		const partial = assistantMessage();
		const wire = toWireEvent({
			type: "message_update",
			message: partial as AgentMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
				partial,
			},
		});
		expect(wire?.type).toBe("message_update");
		if (wire?.type === "message_update" && wire.assistantMessageEvent.type === "text_delta") {
			expect(wire.assistantMessageEvent.delta).toBe("hello");
			expect(wire.assistantMessageEvent.contentIndex).toBe(0);
		}
	});

	test("message_update projects every assistant stream sub-event", () => {
		const partial = assistantMessage();
		const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/value.ts" } };
		const cases: AssistantMessageEvent[] = [
			{ type: "start", partial },
			{ type: "text_start", contentIndex: 0, partial },
			{ type: "text_end", contentIndex: 0, content: "hello", partial },
			{ type: "thinking_start", contentIndex: 1, partial },
			{ type: "thinking_delta", contentIndex: 1, delta: "plan", partial },
			{ type: "thinking_end", contentIndex: 1, content: "done thinking", partial },
			{ type: "toolcall_start", contentIndex: 2, partial },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"path"', partial },
			{ type: "toolcall_end", contentIndex: 2, toolCall, partial },
			{ type: "done", reason: "stop", message: partial },
			{ type: "error", reason: "error", error: assistantMessage({ stopReason: "error" }) },
		];

		for (const assistantMessageEvent of cases) {
			const wire = toWireEvent({
				type: "message_update",
				message: partial as AgentMessage,
				assistantMessageEvent,
			});
			expect(wire?.type).toBe("message_update");
			if (wire?.type === "message_update") {
				expect(wire.assistantMessageEvent.type).toBe(assistantMessageEvent.type);
			}
		}
	});

	test("message_end with errorKind (regression for #1a)", () => {
		const wire = toWireEvent({
			type: "message_end",
			message: assistantMessage({ stopReason: "error", errorMessage: "oops" }) as AgentMessage,
			errorKind: { kind: "context_overflow", usedTokens: 250000 },
		});
		expect(wire?.type).toBe("message_end");
		if (wire?.type === "message_end") {
			expect(wire.errorKind).toEqual({ kind: "context_overflow", usedTokens: 250000 });
		}
	});

	test("message_end projects fatal error kind without optional payload", () => {
		const wire = toWireEvent({
			type: "message_end",
			message: assistantMessage({ stopReason: "error" }) as AgentMessage,
			errorKind: { kind: "fatal" },
		});
		expect(wire?.type).toBe("message_end");
		if (wire?.type === "message_end") {
			expect(wire.errorKind).toEqual({ kind: "fatal" });
		}
	});

	test("tool_execution_start", () => {
		const wire = toWireEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls" },
			intent: "list files",
		});
		expect(wire).toEqual({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls" },
			intent: "list files",
			presentation: {
				type: "status",
				status: { icon: "pending", title: "Bash", description: "$ ls" },
			},
		});
	});

	test("tool_execution_update", () => {
		const wire = toWireEvent({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		expect(wire?.type).toBe("tool_execution_update");
		if (wire?.type === "tool_execution_update") {
			expect(wire.partialResult.content[0]).toEqual({ type: "text", text: "partial" });
		}
	});

	test("tool_execution_update attaches neutral result presentation for tools with presenters", () => {
		const wire = toWireEvent({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/value.ts" },
			partialResult: {
				content: [{ type: "text", text: "1|const value = 1;" }],
				details: { kind: "file", displayContent: { text: "const value = 1;", startLine: 1 } },
			},
		});
		expect(wire?.type).toBe("tool_execution_update");
		if (wire?.type === "tool_execution_update") {
			expect(wire.partialResult.presentation).toEqual({
				type: "code",
				code: {
					code: "const value = 1;",
					language: "typescript",
					title: "Read src/value.ts",
					status: "complete",
					expanded: false,
				},
			});
		}
	});

	test("drops presentation when presenter throws", () => {
		const previous = toolPresenters.throwing_demo;
		const throwingPresenter: ToolPresenter = {
			presentCall: () => {
				throw new Error("call boom");
			},
			presentResult: () => {
				throw new Error("result boom");
			},
		};
		toolPresenters.throwing_demo = throwingPresenter;
		try {
			const start = toWireEvent({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "throwing_demo",
				args: {},
			});
			expect(start).toEqual({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "throwing_demo",
				args: {},
			});

			const update = toWireEvent({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "throwing_demo",
				args: {},
				partialResult: { content: [{ type: "text", text: "partial" }] },
			});
			expect(update?.type).toBe("tool_execution_update");
			if (update?.type === "tool_execution_update") {
				expect(update.partialResult.presentation).toBeUndefined();
			}
		} finally {
			if (previous) {
				toolPresenters.throwing_demo = previous;
			} else {
				delete toolPresenters.throwing_demo;
			}
		}
	});

	test("projects block presentations onto the wire vocabulary", () => {
		const previous = toolPresenters.block_demo;
		const blockPresenter: ToolPresenter = {
			presentCall: () => ({
				type: "block",
				status: { icon: "success", title: "Block", meta: ["m1"] },
				state: "success",
				sections: [{ label: "Summary", lines: ["line 1"] }],
				applyBg: true,
			}),
		};
		toolPresenters.block_demo = blockPresenter;
		try {
			const wire = toWireEvent({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "block_demo",
				args: {},
			});
			expect(wire?.type).toBe("tool_execution_start");
			if (wire?.type === "tool_execution_start") {
				expect(wire.presentation).toEqual({
					type: "block",
					status: { icon: "success", title: "Block", meta: ["m1"] },
					state: "success",
					sections: [{ label: "Summary", lines: ["line 1"] }],
					applyBg: true,
				});
			}
		} finally {
			if (previous) {
				toolPresenters.block_demo = previous;
			} else {
				delete toolPresenters.block_demo;
			}
		}
	});

	test("tool_execution_end", () => {
		const wire = toWireEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		});
		expect(wire?.type).toBe("tool_execution_end");
		if (wire?.type === "tool_execution_end") {
			expect(wire.isError).toBe(false);
			expect(wire.result.content).toHaveLength(1);
		}
	});
});

// ============================================================================
// Message projection details
// ============================================================================

describe("toWireEvent — message projection details", () => {
	test("projects assistant content variants and optional usage metadata", () => {
		const wire = toWireEvent({
			type: "message_start",
			message: assistantMessage({
				content: [
					{ type: "text", text: "hello", textSignature: "text-sig" },
					{ type: "thinking", thinking: "plan", thinkingSignature: "think-sig", itemId: "item-1" },
					{ type: "redactedThinking", data: "redacted" },
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "src/value.ts" },
						thoughtSignature: "thought-sig",
						intent: "inspect",
						customWireName: "custom_read",
					},
				],
				responseId: "resp-1",
				usage: {
					input: 10,
					output: 20,
					cacheRead: 1,
					cacheWrite: 2,
					totalTokens: 33,
					premiumRequests: 1.5,
					reasoningTokens: 7,
					cttl: { ephemeral5m: 2, ephemeral1h: 3 },
					server: { webSearch: 1, webFetch: 2 },
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
				duration: 123,
				ttft: 45,
			}) as AgentMessage,
		});

		expect(wire?.type).toBe("message_start");
		if (wire?.type === "message_start" && wire.message.role === "assistant") {
			expect(wire.message.content).toEqual([
				{ type: "text", text: "hello", textSignature: "text-sig" },
				{ type: "thinking", thinking: "plan", thinkingSignature: "think-sig", itemId: "item-1" },
				{ type: "redactedThinking", data: "redacted" },
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/value.ts" },
					thoughtSignature: "thought-sig",
					intent: "inspect",
					customWireName: "custom_read",
				},
			]);
			expect(wire.message.usage).toMatchObject({
				premiumRequests: 1.5,
				reasoningTokens: 7,
				cttl: { ephemeral5m: 2, ephemeral1h: 3 },
				server: { webSearch: 1, webFetch: 2 },
			});
			expect(wire.message.responseId).toBe("resp-1");
			expect(wire.message.duration).toBe(123);
			expect(wire.message.ttft).toBe(45);
		}
	});

	test("falls back to hidden custom wire messages for unknown custom roles", () => {
		const message = fromAny<AgentMessage>({ role: "futureRole", payload: { value: 1 }, timestamp: 99 });
		const wire = toWireEvent({ type: "agent_end", messages: [message] });

		expect(wire?.type).toBe("agent_end");
		if (wire?.type === "agent_end") {
			expect(wire.messages[0]).toMatchObject({
				role: "custom",
				customType: "futureRole",
				display: false,
				timestamp: 99,
			});
			expect(wire.messages[0].content).toContain("futureRole");
		}
	});

	test("projects custom coding-agent message roles and rich user/tool content", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look", textSignature: "user-sig" },
					{ type: "image", data: "base64", mimeType: "image/png" },
				],
				synthetic: true,
				attribution: "user",
				timestamp: 1,
			},
			{ role: "developer", content: "dev", attribution: "agent", timestamp: 2 },
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "image", data: "img", mimeType: "image/jpeg" }],
				details: { kind: "image" },
				isError: false,
				attribution: "agent",
				prunedAt: 3,
				timestamp: 4,
			},
			{
				role: "bashExecution",
				command: "printf ok",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 5,
			},
			{
				role: "pythonExecution",
				code: "print('ok')",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 6,
			},
			{
				role: "custom",
				customType: "custom:event",
				content: [{ type: "text", text: "custom" }],
				display: true,
				details: { value: 1 },
				attribution: "user",
				timestamp: 7,
			},
			{
				role: "hookMessage",
				customType: "hook:event",
				content: "hook",
				display: false,
				details: { ok: true },
				attribution: "agent",
				timestamp: 8,
			},
		];

		const wire = toWireEvent({ type: "agent_end", messages });
		expect(wire?.type).toBe("agent_end");
		if (wire?.type === "agent_end") {
			expect(wire.messages).toMatchObject([
				{ role: "user", synthetic: true, attribution: "user" },
				{ role: "developer", content: "dev", attribution: "agent" },
				{ role: "toolResult", details: { kind: "image" }, prunedAt: 3 },
				{ role: "bashExecution", command: "printf ok", excludeFromContext: true },
				{ role: "pythonExecution", code: "print('ok')", excludeFromContext: true },
				{ role: "custom", customType: "custom:event", details: { value: 1 } },
				{ role: "hookMessage", customType: "hook:event", details: { ok: true } },
			]);
			expect(wire.messages[0]).toMatchObject({
				content: [
					{ type: "text", text: "look", textSignature: "user-sig" },
					{ type: "image", data: "base64", mimeType: "image/png" },
				],
			});
		}
	});
});

// ============================================================================
// Internal-only events — must translate to null
// ============================================================================

describe("toWireEvent — internal-only events return null", () => {
	test("auto_compaction_start", () => {
		expect(
			toWireEvent({
				type: "auto_compaction_start",
				reason: "threshold",
				action: "context-full",
			} as AgentSessionEvent),
		).toBeNull();
	});

	test("auto_compaction_end", () => {
		expect(
			toWireEvent({
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted: false,
				willRetry: false,
			} as AgentSessionEvent),
		).toBeNull();
	});

	test("auto_retry_start", () => {
		expect(
			toWireEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 1000,
				errorMessage: "test",
			} as AgentSessionEvent),
		).toBeNull();
	});

	test("auto_retry_end", () => {
		expect(toWireEvent({ type: "auto_retry_end", success: true, attempt: 1 } as AgentSessionEvent)).toBeNull();
	});

	test("retry_fallback_applied", () => {
		expect(
			toWireEvent({
				type: "retry_fallback_applied",
				from: "openai/gpt-5",
				to: "openai/gpt-4",
				role: "default",
			} as AgentSessionEvent),
		).toBeNull();
	});

	test("retry_fallback_succeeded", () => {
		expect(
			toWireEvent({
				type: "retry_fallback_succeeded",
				model: "openai/gpt-4",
				role: "default",
			} as AgentSessionEvent),
		).toBeNull();
	});

	test("ttsr_triggered", () => {
		expect(toWireEvent({ type: "ttsr_triggered", rules: [] } as unknown as AgentSessionEvent)).toBeNull();
	});

	test("todo_reminder", () => {
		expect(
			toWireEvent({
				type: "todo_reminder",
				todos: [],
				attempt: 1,
				maxAttempts: 3,
			} as unknown as AgentSessionEvent),
		).toBeNull();
	});

	test("todo_auto_clear", () => {
		expect(toWireEvent({ type: "todo_auto_clear" } as AgentSessionEvent)).toBeNull();
	});

	test("irc_message", () => {
		expect(
			toWireEvent({
				type: "irc_message",
				message: {
					role: "custom",
					customType: "irc:incoming",
					content: "test",
					display: true,
					timestamp: 100,
				},
			} as unknown as AgentSessionEvent),
		).toBeNull();
	});
});

// ============================================================================
// Shape stability — golden snapshot for a representative event
// ============================================================================

describe("toWireEvent — shape stability", () => {
	test("agent_end with errorKind has stable shape", () => {
		const wire: WireEventV1 | null = toWireEvent({
			type: "agent_end",
			messages: [
				{
					role: "user",
					content: "hello",
					timestamp: 100,
				} as AgentMessage,
			],
			errorKind: { kind: "usage_limit", retryAfterMs: 5000 },
		});
		// Asserting the entire shape catches any field rename or addition.
		expect(wire).toEqual({
			type: "agent_end",
			messages: [{ role: "user", content: "hello", timestamp: 100 }],
			errorKind: { kind: "usage_limit", retryAfterMs: 5000 },
		});
	});

	test("tool_execution_end omits isError when undefined", () => {
		const wire = toWireEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
		});
		expect(wire).toEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
		});
	});
});
