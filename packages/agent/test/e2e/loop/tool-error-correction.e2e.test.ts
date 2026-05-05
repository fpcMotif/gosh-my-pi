import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentEvent, AgentTool, AgentToolResult, ToolResultMessage } from "@oh-my-pi/pi-agent-core/types";
import { Type } from "@sinclair/typebox";
import {
	basicConfig,
	emptyContext,
	drainEvents,
	makeToolCall,
	textTurn,
	toolCallTurn,
	turnSequencedStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when a tool call fails, the agent loop must:
 *   1. Surface the failure as a ToolResultMessage with isError=true.
 *   2. Push it into context.messages so the next LLM turn sees it.
 *   3. Continue the loop (not terminate) so the LLM can correct itself.
 *
 * Tests both the "tool throws" path (handleToolExecutionError in
 * packages/agent/src/agent-loop/execution.ts:195) and the multi-turn
 * recovery flow.
 */

function makeTool(spec: { name: string; execute: AgentTool["execute"] }): AgentTool {
	return {
		name: spec.name,
		label: spec.name,
		description: spec.name,
		parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		execute: spec.execute,
	};
}

describe("agent loop — tool error correction", () => {
	it("returns isError=true when tool throws and pushes the result into context", async () => {
		let executions = 0;
		const failingTool = makeTool({
			name: "failer",
			execute: async () => {
				executions += 1;
				throw new Error("kaboom");
			},
		});

		const context = emptyContext();
		context.tools = [failingTool];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("trigger")],
			context,
			config,
			undefined,
			turnSequencedStream([toolCallTurn("failer", { value: "x" }, "tc-1"), textTurn("done after retry")]),
		);
		await drainEvents(stream);

		expect(executions).toBe(1);
		const toolResult = context.messages.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc-1",
		) as ToolResultMessage | undefined;
		expect(toolResult).toBeDefined();
		expect(toolResult?.isError).toBe(true);
		const text = toolResult?.content.find(c => c.type === "text") as { text: string } | undefined;
		expect(text?.text).toContain("kaboom");
	});

	it("continues to a follow-up LLM turn that can issue a corrected tool call", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const tool = makeTool({
			name: "echo",
			execute: async (_id, args) => {
				calls.push(args);
				if (calls.length === 1) throw new Error("bad input");
				const result: AgentToolResult = { content: [{ type: "text", text: "ok" }] };
				return result;
			},
		});

		const context = emptyContext();
		context.tools = [tool];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				toolCallTurn("echo", { value: "wrong" }, "tc-1"),
				toolCallTurn("echo", { value: "right" }, "tc-2"),
				textTurn("finished"),
			]),
		);
		await drainEvents(stream);

		expect(calls.length).toBe(2);
		expect(calls[0]).toEqual({ value: "wrong" });
		expect(calls[1]).toEqual({ value: "right" });

		const errorResult = context.messages.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc-1",
		) as ToolResultMessage | undefined;
		const successResult = context.messages.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc-2",
		) as ToolResultMessage | undefined;
		expect(errorResult?.isError).toBe(true);
		expect(successResult?.isError).toBe(false);
	});

	it("emits a tool_execution_end event with isError=true on failure", async () => {
		const tool = makeTool({
			name: "failer",
			execute: async () => {
				throw new Error("nope");
			},
		});

		const context = emptyContext();
		context.tools = [tool];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([toolCallTurn("failer", {}, "tc-fail"), textTurn("done")]),
		);
		const events = await drainEvents(stream);

		const errorEvents = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "tc-fail",
		);
		expect(errorEvents.length).toBe(1);
		expect(errorEvents[0].isError).toBe(true);
	});

	it("preserves tool_execution_start metadata even when tool throws synchronously", async () => {
		const tool = makeTool({
			name: "syncfail",
			execute: () => {
				throw new Error("sync boom");
			},
		});

		const context = emptyContext();
		context.tools = [tool];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([toolCallTurn("syncfail", { value: "x" }, "tc-sync"), textTurn("done")]),
		);
		const events = await drainEvents(stream);

		const startEvent = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_start" }> =>
				e.type === "tool_execution_start" && e.toolCallId === "tc-sync",
		);
		const endEvent = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "tc-sync",
		);
		expect(startEvent).toBeDefined();
		expect(endEvent).toBeDefined();
		expect(endEvent?.isError).toBe(true);
		// Sync throws must be wrapped exactly like async ones — no leaked Error
		// object reaches the consumer event stream.
		const result = endEvent?.result as ToolResultMessage | undefined;
		expect(result?.isError).toBe(true);
	});
});

// Suppress unused-import lint when tests don't call `makeToolCall` directly.
void makeToolCall;
