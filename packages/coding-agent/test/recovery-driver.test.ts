// Contracts for RecoveryDriver — the layer that turns a classified `CrashState`
// into actions on an `Agent`. The load-bearing property is the `mid-tool`
// safety rule: every pending tool call gets a synthetic `toolResult` with
// `isError: true` and the original tool is NEVER re-run (per ADR-0003).

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentRecoveryFacade,
	applyRecoveryAction,
	decideRecoveryAction,
	type RecoveryAction,
} from "../src/session/recovery-driver";

function assistantWithToolCalls(toolCalls: Array<{ id: string; name: string }>): AssistantMessage {
	return fromPartial<AssistantMessage>({
		role: "assistant",
		content: toolCalls.map(tc => ({
			type: "toolCall",
			id: tc.id,
			name: tc.name,
			arguments: {},
		})),
	});
}

function userMessage(text: string): AgentMessage {
	return fromPartial<AgentMessage>({
		role: "user",
		content: [{ type: "text", text }],
	});
}

class FakeAgent implements AgentRecoveryFacade {
	readonly appended: AgentMessage[] = [];
	replaced: AgentMessage[] | undefined;

	appendMessage(message: AgentMessage): void {
		this.appended.push(message);
	}

	replaceMessages(messages: AgentMessage[]): void {
		this.replaced = [...messages];
	}
}

describe("decideRecoveryAction", () => {
	it("returns kind: none for a safe crash state", () => {
		const action = decideRecoveryAction({ kind: "safe" }, [userMessage("hi")], undefined);
		expect(action).toEqual({ kind: "none" });
	});

	it("returns mid-stream with messages.slice(0, -1) when crash kind is mid-stream", () => {
		const messages = [userMessage("hi"), userMessage("partial assistant placeholder")];
		const action = decideRecoveryAction({ kind: "mid-stream" }, messages, undefined);
		expect(action.kind).toBe("mid-stream");
		if (action.kind !== "mid-stream") throw new Error("unreachable");
		expect(action.replacementMessages).toEqual([messages[0]]);
	});

	it("collapses mid-stream to none when there is nothing to drop", () => {
		const action = decideRecoveryAction({ kind: "mid-stream" }, [], undefined);
		expect(action).toEqual({ kind: "none" });
	});

	it("synthesizes one toolResult per pending id with isError: true", () => {
		const assistant = assistantWithToolCalls([
			{ id: "call-1", name: "bash" },
			{ id: "call-2", name: "edit" },
		]);
		const action = decideRecoveryAction(
			{ kind: "mid-tool", pendingToolCallIds: ["call-1", "call-2"] },
			[userMessage("hi")],
			assistant,
		);
		expect(action.kind).toBe("mid-tool");
		if (action.kind !== "mid-tool") throw new Error("unreachable");
		expect(action.syntheticResults.length).toBe(2);
		const ids = action.syntheticResults.map(r => r.toolCallId);
		expect(ids).toEqual(["call-1", "call-2"]);
		const names = action.syntheticResults.map(r => r.toolName);
		expect(names).toEqual(["bash", "edit"]);
		for (const result of action.syntheticResults) {
			expect(result.role).toBe("toolResult");
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([{ type: "text", text: "interrupted by crash" }]);
		}
	});

	it("falls back to toolName 'unknown' when the pending id has no matching toolCall", () => {
		const assistant = assistantWithToolCalls([{ id: "call-1", name: "bash" }]);
		const action = decideRecoveryAction({ kind: "mid-tool", pendingToolCallIds: ["call-orphan"] }, [], assistant);
		expect(action.kind).toBe("mid-tool");
		if (action.kind !== "mid-tool") throw new Error("unreachable");
		expect(action.syntheticResults[0]?.toolName).toBe("unknown");
		expect(action.syntheticResults[0]?.toolCallId).toBe("call-orphan");
	});

	it("returns none when mid-tool has no latest assistant message (inconsistent log)", () => {
		const action = decideRecoveryAction({ kind: "mid-tool", pendingToolCallIds: ["call-1"] }, [], undefined);
		expect(action).toEqual({ kind: "none" });
	});

	it("returns none when mid-tool has no pending ids (defensive)", () => {
		const assistant = assistantWithToolCalls([{ id: "call-1", name: "bash" }]);
		const action = decideRecoveryAction({ kind: "mid-tool", pendingToolCallIds: [] }, [], assistant);
		expect(action).toEqual({ kind: "none" });
	});

	it("does NOT return any action that would re-run a tool (load-bearing per ADR-0003)", () => {
		// Sentinel test: if some future variant ever produces a non-toolResult
		// message in `mid-tool`'s output, the synthetic-only contract is broken.
		const assistant = assistantWithToolCalls([{ id: "call-1", name: "bash" }]);
		const action = decideRecoveryAction({ kind: "mid-tool", pendingToolCallIds: ["call-1"] }, [], assistant);
		if (action.kind !== "mid-tool") throw new Error("expected mid-tool");
		for (const result of action.syntheticResults) {
			expect(result.role).toBe("toolResult");
			expect(result.isError).toBe(true);
		}
	});
});

describe("applyRecoveryAction", () => {
	it("does nothing for kind: none", () => {
		const agent = new FakeAgent();
		applyRecoveryAction({ kind: "none" }, agent);
		expect(agent.appended).toEqual([]);
		expect(agent.replaced).toBeUndefined();
	});

	it("calls replaceMessages for mid-stream", () => {
		const agent = new FakeAgent();
		const replacement = [userMessage("a"), userMessage("b")];
		const action: RecoveryAction = { kind: "mid-stream", replacementMessages: replacement };
		applyRecoveryAction(action, agent);
		expect(agent.replaced).toEqual(replacement);
		expect(agent.appended).toEqual([]);
	});

	it("calls appendMessage once per synthetic for mid-tool, never replaceMessages", () => {
		const agent = new FakeAgent();
		const synthetics: ToolResultMessage[] = [
			fromPartial<ToolResultMessage>({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "interrupted by crash" }],
				isError: true,
				timestamp: 0,
			}),
			fromPartial<ToolResultMessage>({
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "edit",
				content: [{ type: "text", text: "interrupted by crash" }],
				isError: true,
				timestamp: 0,
			}),
		];
		applyRecoveryAction({ kind: "mid-tool", syntheticResults: synthetics }, agent);
		expect(agent.appended).toEqual(synthetics);
		expect(agent.replaced).toBeUndefined();
	});
});
