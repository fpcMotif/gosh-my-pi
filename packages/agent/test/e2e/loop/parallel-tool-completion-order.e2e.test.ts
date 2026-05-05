import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentEvent, AgentTool, ToolResultMessage } from "@oh-my-pi/pi-agent-core/types";
import { Type } from "@sinclair/typebox";
import {
	basicConfig,
	drainEvents,
	emptyContext,
	makeToolCall,
	scriptedStream,
	textTurn,
	turnSequencedStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when multiple tool calls are emitted in one assistant turn,
 * the agent loop preserves the LLM-emitted call order in
 * `context.messages` (so transcripts are deterministic) regardless of
 * actual execution order or tool concurrency settings.
 *
 * Lockdown coverage of execution.ts execute paths.
 */

function delayedTool(name: string, delayMs: number, sink: string[]): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => {
			await Bun.sleep(delayMs);
			sink.push(name);
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("agentLoop — parallel tool completion ordering", () => {
	it("appends toolResults to context.messages in completion order under the concurrent path", async () => {
		const sink: string[] = [];
		const context = emptyContext();
		context.tools = [delayedTool("alpha", 30, sink), delayedTool("beta", 5, sink), delayedTool("gamma", 20, sink)];
		const config = basicConfig();

		const tcAlpha = makeToolCall("alpha", {}, "ta");
		const tcBeta = makeToolCall("beta", {}, "tb");
		const tcGamma = makeToolCall("gamma", {}, "tg");

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: "{}" },
					{ kind: "toolDone", toolCall: tcAlpha },
					{ kind: "toolDone", toolCall: tcBeta },
					{ kind: "toolDone", toolCall: tcGamma },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("done"),
			]),
		);
		await drainEvents(stream);

		const results = context.messages.filter(m => m.role === "toolResult") as ToolResultMessage[];
		expect(results.length).toBe(3);
		// Completion order: beta(5ms) < gamma(20ms) < alpha(30ms). The agent
		// loop's concurrent path pushes each result to context as it lands —
		// NOT in the LLM-emitted toolCall order. UI consumers that need
		// call-order rendering must look up by toolCallId on the original
		// AssistantMessage.content rather than rely on context order.
		expect(results.map(r => r.toolCallId)).toEqual(["tb", "tg", "ta"]);
		expect(sink).toEqual(["beta", "gamma", "alpha"]);
	});

	it("emits exactly one tool_execution_end per toolCall", async () => {
		const sink: string[] = [];
		const context = emptyContext();
		context.tools = [delayedTool("alpha", 5, sink), delayedTool("beta", 5, sink)];
		const config = basicConfig();

		const tcA = makeToolCall("alpha", {}, "a");
		const tcB = makeToolCall("beta", {}, "b");

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: "{}" },
					{ kind: "toolDone", toolCall: tcA },
					{ kind: "toolDone", toolCall: tcB },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("done"),
			]),
		);
		const events = await drainEvents(stream);

		const aEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "a",
		);
		const bEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				e.type === "tool_execution_end" && e.toolCallId === "b",
		);
		expect(aEnds.length).toBe(1);
		expect(bEnds.length).toBe(1);
	});

	it("does not start tools that follow a steering interrupt", async () => {
		const started: string[] = [];
		const context = emptyContext();
		context.tools = [
			{
				name: "alpha",
				label: "alpha",
				description: "alpha",
				parameters: Type.Object({}),
				execute: async () => {
					started.push("alpha");
					return { content: [{ type: "text", text: "a" }] };
				},
			},
			{
				name: "beta",
				label: "beta",
				description: "beta",
				parameters: Type.Object({}),
				execute: async () => {
					started.push("beta");
					return { content: [{ type: "text", text: "b" }] };
				},
			},
		];

		let steered = false;
		const config = basicConfig({
			interruptMode: "immediate",
			getSteeringMessages: async () => {
				if (started.length === 1 && !steered) {
					steered = true;
					return [userMessage("interrupt")];
				}
				return [];
			},
		});

		const tcA = makeToolCall("alpha", {}, "a");
		const tcB = makeToolCall("beta", {}, "b");
		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: "{}" },
					{ kind: "toolDone", toolCall: tcA },
					{ kind: "toolDone", toolCall: tcB },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("done"),
			]),
		);
		await drainEvents(stream);

		expect(started).toEqual(["alpha"]);
	});
});

void scriptedStream;
