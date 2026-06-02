import { describe, expect, it } from "bun:test";
import { fromAny } from "@total-typescript/shoehorn";
import type { AgentSessionEvent } from "../../../src/session/agent-session";
import { mapAgentSessionEventToAcpSessionUpdates, mapToolKind } from "../../../src/modes/acp/acp-event-mapper";

describe("ACP event mapper", () => {
	it("maps known tool names to ACP tool kinds and unknown tools to other", () => {
		expect(mapToolKind("read")).toBe("read");
		expect(mapToolKind("write")).toBe("edit");
		expect(mapToolKind("bash")).toBe("execute");
		expect(mapToolKind("web_search")).toBe("fetch");
		expect(mapToolKind("todo_write")).toBe("think");
		expect(mapToolKind("custom_tool")).toBe("other");
	});

	it("maps tool lifecycle events with title, status, raw payloads, content, and locations", () => {
		const start = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "write",
				args: { path: "a.ts", newPath: "b.ts" },
				intent: "  update file  ",
			}),
			"session-1",
		);
		const update = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "write",
				args: {},
				partialResult: { content: [{ type: "text", text: "partial" }] },
			}),
			"session-1",
		);
		const end = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "write",
				result: { content: [{ type: "text", text: "failed" }] },
				isError: true,
			}),
			"session-1",
		);

		expect(start).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "call-1",
					title: "update file",
					kind: "edit",
					status: "pending",
					rawInput: { path: "a.ts", newPath: "b.ts" },
					locations: [{ path: "a.ts" }, { path: "b.ts" }],
				},
			},
		]);
		expect(update[0].update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "in_progress",
			content: [{ type: "content", content: { type: "text", text: "partial" } }],
		});
		expect(end[0].update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: "failed" } }],
		});
	});

	it("falls back to argument-derived tool titles when intent is absent", () => {
		const [pathUpdate] = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
			"session-1",
		);
		const [commandUpdate] = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "tool_execution_start",
				toolCallId: "bash-1",
				toolName: "bash",
				args: { command: "bun check" },
			}),
			"session-1",
		);
		const [bareUpdate] = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "tool_execution_start",
				toolCallId: "custom-1",
				toolName: "custom",
				args: {},
			}),
			"session-1",
		);

		expect(pathUpdate.update).toMatchObject({ title: "read: README.md" });
		expect(commandUpdate.update).toMatchObject({ title: "bash: bun check" });
		expect(bareUpdate.update).toMatchObject({ title: "custom" });
	});

	it("maps assistant deltas and filters non-assistant or empty updates", () => {
		const text = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			}),
			"session-1",
			{ getMessageId: () => "msg-1" },
		);
		const thought = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
			}),
			"session-1",
		);
		const error = mapAgentSessionEventToAcpSessionUpdates(
			fromAny<AgentSessionEvent>({
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "error", error: {} },
			}),
			"session-1",
		);

		expect(text).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "hello" },
					messageId: "msg-1",
				},
			},
		]);
		expect(thought[0].update).toMatchObject({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "thinking" },
		});
		expect(error[0].update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Unknown error" },
		});
		expect(
			mapAgentSessionEventToAcpSessionUpdates(
				fromAny<AgentSessionEvent>({
					type: "message_update",
					message: { role: "user" },
					assistantMessageEvent: { type: "text_delta", delta: "hidden" },
				}),
				"session-1",
			),
		).toEqual([]);
		expect(
			mapAgentSessionEventToAcpSessionUpdates(
				fromAny<AgentSessionEvent>({
					type: "message_update",
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", delta: "" },
				}),
				"session-1",
			),
		).toEqual([]);
	});

	it("maps todo reminders and clears ACP plan entries", () => {
		expect(
			mapAgentSessionEventToAcpSessionUpdates(
				fromAny<AgentSessionEvent>({
					type: "todo_reminder",
					todos: [
						{ content: "todo", status: "pending" },
						{ content: "doing", status: "in_progress" },
						{ content: "done", status: "completed" },
						{ content: "dropped", status: "abandoned" },
					],
				}),
				"session-1",
			),
		).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "plan",
					entries: [
						{ content: "todo", priority: "medium", status: "pending" },
						{ content: "doing", priority: "medium", status: "in_progress" },
						{ content: "done", priority: "medium", status: "completed" },
						{ content: "dropped", priority: "medium", status: "completed" },
					],
				},
			},
		]);
		expect(
			mapAgentSessionEventToAcpSessionUpdates(fromAny<AgentSessionEvent>({ type: "todo_auto_clear" }), "session-1"),
		).toEqual([{ sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } }]);
	});

	it("drops internal-only event variants that ACP does not surface", () => {
		expect(mapAgentSessionEventToAcpSessionUpdates(fromAny<AgentSessionEvent>({ type: "agent_start" }), "s")).toEqual(
			[],
		);
	});
});
