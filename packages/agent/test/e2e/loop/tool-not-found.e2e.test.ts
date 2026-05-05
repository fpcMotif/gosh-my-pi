import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentTool, ToolResultMessage } from "@oh-my-pi/pi-agent-core/types";
import { Type } from "@sinclair/typebox";
import {
	basicConfig,
	emptyContext,
	drainEvents,
	textTurn,
	toolCallTurn,
	turnSequencedStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when an LLM emits a toolCall whose name is not present in
 * `context.tools`, the agent loop must:
 *   1. Push a ToolResultMessage with isError=true into context.
 *   2. Continue the loop so the LLM can self-correct.
 *   3. Surface the unknown tool name in the error text.
 *
 * The "helpful error" test asserts that the error message includes the
 * available tools so the LLM has actionable feedback. This is the bug
 * surface for execution.ts:130-141 (handleToolNotFound) - the existing
 * implementation returns 'Error: Tool "X" not found.' without listing
 * what IS available, so the LLM has no signal for what to try next.
 */

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

describe("agent loop — tool not found", () => {
	it("synthesises an isError=true result and continues the loop when an unknown tool is called", async () => {
		const context = emptyContext();
		context.tools = [makeTool("known")];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([toolCallTurn("ghost", {}, "tc-ghost"), textTurn("recovered")]),
		);
		await drainEvents(stream);

		const result = context.messages.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc-ghost",
		) as ToolResultMessage | undefined;
		expect(result).toBeDefined();
		expect(result?.isError).toBe(true);
		// The tool name MUST appear in the error text so the LLM can recognise
		// what it called.
		const text = result?.content.find(c => c.type === "text") as { text: string } | undefined;
		expect(text?.text).toContain("ghost");
	});

	it("includes the available tool names in the error so the LLM has actionable feedback", async () => {
		// THIS is the contract that drives the execution.ts:130-141 fix.
		// Currently expected to fail because handleToolNotFound builds
		// `Error: Tool "${name}" not found.` with no list of valid tools.
		const context = emptyContext();
		context.tools = [makeTool("alpha"), makeTool("beta"), makeTool("gamma")];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([toolCallTurn("delta", {}, "tc-d"), textTurn("done")]),
		);
		await drainEvents(stream);

		const result = context.messages.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc-d",
		) as ToolResultMessage | undefined;
		const text = (result?.content.find(c => c.type === "text") as { text: string } | undefined)?.text ?? "";
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
		expect(text).toContain("gamma");
	});

	it("does not crash or short-circuit when an MCP-style namespaced tool name is unknown", async () => {
		// MCP servers expose tools as `mcp__<server>__<tool>`. If the server
		// disappeared between turns, the LLM may still try the old name.
		// Contract: error path is identical (no special-case crash).
		const context = emptyContext();
		context.tools = [makeTool("alpha")];
		const config = basicConfig();

		const stream = agentLoop(
			[userMessage("go")],
			context,
			config,
			undefined,
			turnSequencedStream([toolCallTurn("mcp__bogus__do_thing", {}, "tc-mcp"), textTurn("done")]),
		);
		await drainEvents(stream);

		const result = context.messages.find(
			m => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "tc-mcp",
		) as ToolResultMessage | undefined;
		expect(result).toBeDefined();
		expect(result?.isError).toBe(true);
		const text = (result?.content.find(c => c.type === "text") as { text: string } | undefined)?.text ?? "";
		expect(text).toContain("mcp__bogus__do_thing");
	});
});
