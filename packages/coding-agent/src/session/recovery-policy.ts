// RecoveryPolicy — pure classifier read once on session reopen. Reads the
// session JSONL tail plus the latest RecoveryMarker and decides whether the
// previous process exit left the agent in `safe`, `mid-stream`, or
// `mid-tool` state. The caller (agent-storage.ts in P3b.4) then drives the
// recovery action: no-op for `safe`, `agent.continue()` for `mid-stream`,
// synthetic-error tool_results plus `agent.continue()` for `mid-tool`.
//
// Per ADR-0003, this is a POLICY over the existing JSONL log; it does NOT
// replay tool calls. The `mid-tool = synthetic error tool_result, NEVER
// re-run` rule is the load-bearing safety property — tools are not
// idempotent, so auto-resuming a bash/edit/MCP call would silently
// double-apply side effects.
//
// CONTEXT.md:495-507 documents the term + avoid list.

import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import type { RecoveryMarkerEntry, SessionEntry, SessionMessageEntry } from "./session-manager";

/**
 * Classification of the agent's state at the moment the previous process
 * exited. Drives RecoveryPolicy's reopen action.
 */
export type CrashState = { kind: "safe" } | { kind: "mid-stream" } | { kind: "mid-tool"; pendingToolCallIds: string[] };

/**
 * Find the latest `recovery-marker` entry in a session log tail. Returns
 * `undefined` if none exists (fresh session, or session predating
 * `OMP_RECOVERY_POLICY` adoption).
 */
export function findLatestRecoveryMarker(entries: readonly SessionEntry[]): RecoveryMarkerEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "recovery-marker") return entry;
	}
	return undefined;
}

/**
 * Classify the crash state given a session log and the latest marker.
 * Pure function — no I/O, no side effects.
 *
 * Algorithm:
 *   1. No marker → `safe` (no recovery state to reason about).
 *   2. The marker's `pendingToolCallIds` are tools dispatched but not
 *      yet observed `tool_execution_end` for AS OF the marker. Some of
 *      them may have completed BETWEEN the marker and the kill (each
 *      `tool_execution_end` writes a fresh marker, but a kill mid-tool
 *      means no follow-up marker). Cross-reference against the entries
 *      AFTER the marker — any toolResult message there represents a
 *      completed tool. Subtract those, and the remainder is still pending.
 *      If the remainder is non-empty → `mid-tool`.
 *   3. Else, if the marker's `isStreaming` flag is `true` → `mid-stream`.
 *      The agent was streaming a response when killed; the in-memory
 *      partial is gone but the persisted log is consistent.
 *   4. Else → `safe`.
 *
 * The mid-tool branch is the load-bearing one: the caller MUST append
 * synthetic `tool_execution_end` entries with `isError: true` for each
 * `pendingToolCallIds` and MUST NOT re-run the tool itself.
 */
export function classifyCrashState(
	entries: readonly SessionEntry[],
	marker: RecoveryMarkerEntry | undefined,
): CrashState {
	if (marker === undefined) return { kind: "safe" };

	const completedAfterMarker = collectCompletedToolCallIdsAfter(entries, marker);
	const stillPending = marker.pendingToolCallIds.filter(id => !completedAfterMarker.has(id));
	if (stillPending.length > 0) {
		return { kind: "mid-tool", pendingToolCallIds: stillPending };
	}

	if (marker.isStreaming) return { kind: "mid-stream" };

	return { kind: "safe" };
}

/**
 * Walk entries strictly AFTER `marker` and collect tool-call ids that
 * have a corresponding `toolResult` message. Used to subtract from the
 * marker's `pendingToolCallIds`.
 */
function collectCompletedToolCallIdsAfter(entries: readonly SessionEntry[], marker: RecoveryMarkerEntry): Set<string> {
	const completed = new Set<string>();
	let pastMarker = false;
	for (const entry of entries) {
		if (!pastMarker) {
			if (entry === marker || entry.id === marker.id) pastMarker = true;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = (entry as SessionMessageEntry).message;
		if (message.role === "toolResult") {
			completed.add(message.toolCallId);
		}
	}
	return completed;
}

/**
 * Find the latest assistant message in the session log. Used by the
 * `mid-tool` recovery branch to look up the original `ToolCall` shape so
 * the synthetic `tool_execution_end` entries carry the right
 * `toolCallId` / `toolName` pair.
 */
export function findLatestAssistantMessage(entries: readonly SessionEntry[]): AssistantMessage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = (entry as SessionMessageEntry).message;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

/**
 * Extract a tool call by id from an assistant message's content. Returns
 * `undefined` if not found (which means the marker's `pendingToolCallIds`
 * is inconsistent with the trailing assistant message — the caller should
 * fall back to a generic synthetic error).
 */
export function findToolCallById(message: AssistantMessage, toolCallId: string): ToolCall | undefined {
	for (const content of message.content) {
		if (content.type === "toolCall" && content.id === toolCallId) return content;
	}
	return undefined;
}
