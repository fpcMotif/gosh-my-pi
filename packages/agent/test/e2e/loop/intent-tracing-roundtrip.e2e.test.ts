import { describe, expect, it } from "bun:test";
import { agentLoop, INTENT_FIELD } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { Type } from "@sinclair/typebox";
import {
	basicConfig,
	emptyContext,
	drainEvents,
	makeToolCall,
	textTurn,
	turnSequencedStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when `intentTracing: true`, the agent loop normalises tools so
 * each one exposes an optional `intent` field, then strips that field from
 * the arguments before invoking `tool.execute(...)`. The intent value is
 * carried separately to the tool_execution_start event for observability.
 *
 * Lockdown coverage - the existing implementation is correct (see
 * normalizeTools / extractIntent in streaming.ts and execution.ts).
 */

function makeTool(spec: { name: string; intent?: AgentTool["intent"] }): AgentTool {
	return {
		name: spec.name,
		label: spec.name,
		description: spec.name,
		parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		intent: spec.intent,
		execute: async (_id, args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
	};
}

describe("agent loop — intent tracing roundtrip", () => {
	it("strips the intent field from args before passing them to tool.execute when tracing is enabled", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const tool: AgentTool = {
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: Type.Object({ value: Type.Optional(Type.String()) }),
			intent: "optional",
			execute: async (_id, args) => {
				capturedArgs = args;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};

		const context = emptyContext();
		context.tools = [tool];
		const config = basicConfig({ intentTracing: true });

		const toolCall = makeToolCall("echo", { value: "hello", [INTENT_FIELD]: "user wants a greeting" }, "tc-1");
		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: JSON.stringify({ value: "hello" }) },
					{ kind: "toolDone", toolCall },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("ok"),
			]),
		);
		await drainEvents(stream);

		expect(capturedArgs).toBeDefined();
		// intent must NOT leak into the tool's args
		expect(capturedArgs).not.toHaveProperty(INTENT_FIELD);
		expect(capturedArgs?.value).toBe("hello");
	});

	it("emits the intent string on the tool_execution_start event", async () => {
		const tool = makeTool({ name: "echo", intent: "optional" });
		const context = emptyContext();
		context.tools = [tool];
		const config = basicConfig({ intentTracing: true });

		const toolCall = makeToolCall("echo", { value: "v", [INTENT_FIELD]: "describe the user-visible goal" }, "tc-2");
		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: JSON.stringify({ value: "v" }) },
					{ kind: "toolDone", toolCall },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("ok"),
			]),
		);
		const events = await drainEvents(stream);

		const start = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_start" }> =>
				e.type === "tool_execution_start" && e.toolCallId === "tc-2",
		);
		expect(start).toBeDefined();
		expect(start?.intent).toBe("describe the user-visible goal");
	});

	it("does not inject or extract the intent field when intentTracing is disabled", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const tool: AgentTool = {
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: Type.Object({ value: Type.Optional(Type.String()) }),
			intent: "optional",
			execute: async (_id, args) => {
				capturedArgs = args;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};

		const context = emptyContext();
		context.tools = [tool];
		const config = basicConfig({ intentTracing: false });

		// LLM mistakenly includes intent even though tracing is off; agent
		// loop should pass it through untouched (it's just an unknown arg).
		const toolCall = makeToolCall("echo", { value: "v", [INTENT_FIELD]: "leaked intent" }, "tc-3");
		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: JSON.stringify({ value: "v" }) },
					{ kind: "toolDone", toolCall },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("ok"),
			]),
		);
		const events = await drainEvents(stream);

		// With tracing OFF, the agent loop is a passthrough on intent: the
		// arg is preserved as-is and no `intent` value is reported on the
		// tool_execution_start event.
		expect(capturedArgs?.[INTENT_FIELD]).toBe("leaked intent");
		const start = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_start" }> =>
				e.type === "tool_execution_start" && e.toolCallId === "tc-3",
		);
		expect(start?.intent).toBeUndefined();
	});
});
