import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentMessage, AgentTool, ToolResultMessage } from "@oh-my-pi/pi-agent-core/types";
import { Type } from "@sinclair/typebox";
import {
	basicConfig,
	emptyContext,
	drainEvents,
	makeToolCall,
	scriptedStream,
	textTurn,
	turnSequencedStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when `interruptMode === "immediate"`, the agent loop must check
 * `getSteeringMessages()` between tool calls and skip remaining ones in the
 * batch when steering arrives (execution.ts:61-66). When mode is "wait",
 * all tools in the batch run before steering is consulted.
 */

function makeTool(name: string, onCall: () => void): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => {
			onCall();
			return { content: [{ type: "text", text: name }] };
		},
	};
}

function multiToolBatchScript() {
	const tc1 = makeToolCall("alpha", {}, "b-1");
	const tc2 = makeToolCall("beta", {}, "b-2");
	const tc3 = makeToolCall("gamma", {}, "b-3");
	return [
		{ kind: "toolDelta" as const, partialJson: "{}" },
		{ kind: "toolDone" as const, toolCall: tc1 },
		{ kind: "toolDone" as const, toolCall: tc2 },
		{ kind: "toolDone" as const, toolCall: tc3 },
		{ kind: "done" as const, reason: "toolUse" as const },
	];
}

describe("agent loop — steering interrupt (immediate)", () => {
	it("skips remaining tool calls in the batch when steering arrives mid-batch", async () => {
		const calls: string[] = [];
		const context = emptyContext();
		context.tools = [
			makeTool("alpha", () => calls.push("alpha")),
			makeTool("beta", () => calls.push("beta")),
			makeTool("gamma", () => calls.push("gamma")),
		];

		// getSteeringMessages returns a steering message after the first
		// tool call has run.
		let steeringEmitted = false;
		const steerMessage: AgentMessage = userMessage("changed mind");
		const config = basicConfig({
			interruptMode: "immediate",
			getSteeringMessages: async () => {
				if (calls.length === 1 && !steeringEmitted) {
					steeringEmitted = true;
					return [steerMessage];
				}
				return [];
			},
		});

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([multiToolBatchScript(), textTurn("done after steer")]),
		);
		await drainEvents(stream);

		// Only `alpha` should have run; `beta` and `gamma` are skipped.
		expect(calls).toEqual(["alpha"]);
	});

	it("runs all tools in the batch when interruptMode is 'wait'", async () => {
		const calls: string[] = [];
		const context = emptyContext();
		context.tools = [
			makeTool("alpha", () => calls.push("alpha")),
			makeTool("beta", () => calls.push("beta")),
			makeTool("gamma", () => calls.push("gamma")),
		];

		const config = basicConfig({
			interruptMode: "wait",
			getSteeringMessages: async () => [userMessage("steer")],
		});

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([multiToolBatchScript(), textTurn("done")]),
		);
		await drainEvents(stream);

		expect(calls).toEqual(["alpha", "beta", "gamma"]);
	});

	it("returns truncated toolResults when steering aborts mid-batch", async () => {
		const context = emptyContext();
		context.tools = [makeTool("alpha", () => {}), makeTool("beta", () => {}), makeTool("gamma", () => {})];

		let steered = false;
		const config = basicConfig({
			interruptMode: "immediate",
			getSteeringMessages: async () => {
				if (steered) return [];
				steered = true;
				return [userMessage("interrupt")];
			},
		});

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([multiToolBatchScript(), textTurn("done")]),
		);
		await drainEvents(stream);

		const toolResults = context.messages.filter(m => m.role === "toolResult") as ToolResultMessage[];
		// The steering check fires BEFORE the first tool when getSteeringMessages
		// returns immediately, so we may end with 0 results or 1 result depending
		// on exact ordering. The contract: results length is < 3 (less than full
		// batch) - never == 3 when steering interrupts.
		expect(toolResults.length).toBeLessThan(3);
	});

	it("continues normally when getSteeringMessages returns an empty array", async () => {
		const calls: string[] = [];
		const context = emptyContext();
		context.tools = [makeTool("alpha", () => calls.push("alpha")), makeTool("beta", () => calls.push("beta"))];

		const config = basicConfig({
			interruptMode: "immediate",
			getSteeringMessages: async () => [],
		});

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([
				[
					{ kind: "toolDelta", partialJson: "{}" },
					{ kind: "toolDone", toolCall: makeToolCall("alpha", {}, "a") },
					{ kind: "toolDone", toolCall: makeToolCall("beta", {}, "b") },
					{ kind: "done", reason: "toolUse" },
				],
				textTurn("done"),
			]),
		);
		await drainEvents(stream);

		expect(calls).toEqual(["alpha", "beta"]);
	});
});

void scriptedStream;
