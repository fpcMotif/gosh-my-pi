// Contracts for RecoveryPolicy — the pure classifier read once on session
// reopen. The mid-tool safety property (NEVER auto-re-run a tool) is
// load-bearing per ADR-0003 and gets its own dedicated test.

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	classifyCrashState,
	findLatestAssistantMessage,
	findLatestRecoveryMarker,
	findToolCallById,
} from "../src/session/recovery-policy";
import type { RecoveryMarkerEntry, SessionEntry, SessionMessageEntry } from "../src/session/session-manager";

function marker(payload: {
	id?: string;
	generation: number;
	lastEventSeq?: number;
	isStreaming?: boolean;
	pendingToolCallIds?: string[];
}): RecoveryMarkerEntry {
	return fromPartial<RecoveryMarkerEntry>({
		type: "recovery-marker",
		id: payload.id ?? `m${payload.generation}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		generation: payload.generation,
		lastEventSeq: payload.lastEventSeq ?? 0,
		isStreaming: payload.isStreaming ?? false,
		pendingToolCallIds: payload.pendingToolCallIds ?? [],
	});
}

function assistantWithToolCalls(toolCallIds: string[]): SessionMessageEntry {
	return fromPartial<SessionMessageEntry>({
		type: "message",
		id: "asst-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: fromPartial<AssistantMessage>({
			role: "assistant",
			content: toolCallIds.map(id => ({
				type: "toolCall",
				id,
				name: "bash",
				arguments: {},
			})),
		}),
	});
}

function toolResultEntry(toolCallId: string): SessionMessageEntry {
	return fromPartial<SessionMessageEntry>({
		type: "message",
		id: `result-${toolCallId}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: fromPartial<ToolResultMessage>({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
		}),
	});
}

describe("classifyCrashState", () => {
	it("returns safe when no marker exists in the session log", () => {
		const result = classifyCrashState([], undefined);
		expect(result).toEqual({ kind: "safe" });
	});

	it("returns safe when the marker has no pending tools and was not streaming", () => {
		const m = marker({ generation: 1 });
		const result = classifyCrashState([m], m);
		expect(result).toEqual({ kind: "safe" });
	});

	it("returns mid-stream when the marker carries isStreaming=true and no pending tools", () => {
		const m = marker({ generation: 1, isStreaming: true });
		const result = classifyCrashState([m], m);
		expect(result).toEqual({ kind: "mid-stream" });
	});

	it("returns mid-tool when the marker has pending tools and none completed after", () => {
		const m = marker({ generation: 1, pendingToolCallIds: ["A", "B"] });
		const entries: SessionEntry[] = [assistantWithToolCalls(["A", "B"]), m];
		const result = classifyCrashState(entries, m);
		expect(result).toEqual({ kind: "mid-tool", pendingToolCallIds: ["A", "B"] });
	});

	it("subtracts completed tool ids: only A's tool_execution_end seen → mid-tool [B]", () => {
		const m = marker({ generation: 1, pendingToolCallIds: ["A", "B"] });
		const entries: SessionEntry[] = [assistantWithToolCalls(["A", "B"]), m, toolResultEntry("A")];
		const result = classifyCrashState(entries, m);
		expect(result).toEqual({ kind: "mid-tool", pendingToolCallIds: ["B"] });
	});

	it("returns safe when all pending tools completed after the marker", () => {
		const m = marker({ generation: 1, pendingToolCallIds: ["A"] });
		const entries: SessionEntry[] = [assistantWithToolCalls(["A"]), m, toolResultEntry("A")];
		const result = classifyCrashState(entries, m);
		expect(result).toEqual({ kind: "safe" });
	});

	it("CRITICAL SAFETY: bash tool started but didn't finish → mid-tool not safe (never re-runs)", () => {
		// Marker captured the moment the assistant message ended, listing both tool ids
		// as pending. Process killed before any tool_execution_end was written.
		// Classifier MUST flag mid-tool so RecoveryPolicy can write synthetic-error
		// tool_results — never auto-rerun the bash command.
		const m = marker({
			generation: 1,
			pendingToolCallIds: ["call-bash-rm-rf", "call-bash-write-secret"],
		});
		const entries: SessionEntry[] = [
			assistantWithToolCalls(["call-bash-rm-rf", "call-bash-write-secret"]),
			m,
			// No tool_execution_end entries — process was killed mid-dispatch.
		];
		const result = classifyCrashState(entries, m);
		expect(result.kind).toBe("mid-tool");
		expect(result.kind === "mid-tool" ? result.pendingToolCallIds : []).toEqual([
			"call-bash-rm-rf",
			"call-bash-write-secret",
		]);
	});

	it("prefers mid-tool over mid-stream when both could fire (pending tools dominate)", () => {
		const m = marker({ generation: 1, isStreaming: true, pendingToolCallIds: ["A"] });
		const entries: SessionEntry[] = [assistantWithToolCalls(["A"]), m];
		const result = classifyCrashState(entries, m);
		expect(result).toEqual({ kind: "mid-tool", pendingToolCallIds: ["A"] });
	});
});

describe("findLatestRecoveryMarker", () => {
	it("returns undefined when no marker exists", () => {
		const result = findLatestRecoveryMarker([assistantWithToolCalls(["A"])]);
		expect(result).toBeUndefined();
	});

	it("returns the highest-generation marker when multiple exist", () => {
		const m1 = marker({ id: "m1", generation: 1 });
		const m2 = marker({ id: "m2", generation: 2 });
		const m3 = marker({ id: "m3", generation: 3 });
		const result = findLatestRecoveryMarker([m1, m2, m3]);
		expect(result?.id).toBe("m3");
	});

	it("ignores non-recovery-marker entries", () => {
		const m = marker({ generation: 1 });
		const result = findLatestRecoveryMarker([assistantWithToolCalls(["A"]), m, toolResultEntry("A")]);
		expect(result?.id).toBe(m.id);
	});
});

describe("findLatestAssistantMessage", () => {
	it("returns the latest assistant message before the latest marker", () => {
		const asst = assistantWithToolCalls(["A"]);
		const m = marker({ generation: 1, pendingToolCallIds: ["A"] });
		const result = findLatestAssistantMessage([asst, m]);
		expect(result?.role).toBe("assistant");
	});

	it("returns undefined when no assistant message in the log", () => {
		const result = findLatestAssistantMessage([toolResultEntry("A")]);
		expect(result).toBeUndefined();
	});
});

describe("findToolCallById", () => {
	it("returns the tool call when the id matches", () => {
		const message = fromPartial<AssistantMessage>({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "A", name: "bash", arguments: {} },
				{ type: "toolCall", id: "B", name: "edit", arguments: {} },
			],
		});
		const result = findToolCallById(message, "B");
		expect(result?.id).toBe("B");
		expect(result?.name).toBe("edit");
	});

	it("returns undefined when the id is not present", () => {
		const message = fromPartial<AssistantMessage>({
			role: "assistant",
			content: [{ type: "toolCall", id: "A", name: "bash", arguments: {} }],
		});
		const result = findToolCallById(message, "Z");
		expect(result).toBeUndefined();
	});
});
