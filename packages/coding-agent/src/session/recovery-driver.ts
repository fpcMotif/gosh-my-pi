// RecoveryDriver — turns a classified `CrashState` (from `RecoveryPolicy`)
// into mutations on a live `Agent`. Per ADR-0003, the load-bearing safety
// property is `mid-tool`: every pending tool call gets a synthetic
// `toolResult` with `isError: true` and the literal text `"interrupted by
// crash"`; the original tool is **never** re-run because tools are not
// idempotent — auto-resuming would silently double-apply side effects.
// CONTEXT.md:495-507 documents the term + avoid list.

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	type CrashState,
	classifyCrashState,
	findLatestAssistantMessage,
	findLatestRecoveryMarker,
	findToolCallById,
} from "./recovery-policy";
import type { SessionEntry } from "./session-manager";

/**
 * Structured description of what `decideRecoveryAction` decided. The driver
 * applies these to an Agent; the orchestrator returns this so callers can
 * decide whether to call `agent.continue()` after recovery.
 */
export type RecoveryAction =
	| { readonly kind: "none" }
	| { readonly kind: "mid-stream"; readonly replacementMessages: readonly AgentMessage[] }
	| { readonly kind: "mid-tool"; readonly syntheticResults: readonly ToolResultMessage[] };

/** Minimal Agent surface the driver mutates — kept tight so tests can fake it. */
export interface AgentRecoveryFacade {
	appendMessage(message: AgentMessage): void;
	replaceMessages(messages: AgentMessage[]): void;
}

/** Literal message body the synthetic toolResult carries. */
const INTERRUPTED_TEXT = "interrupted by crash";

/** Fallback toolName when the marker's pending id has no match in the latest assistant message. */
const UNKNOWN_TOOL_NAME = "unknown";

/**
 * Compute the recovery action for a given crash state. Pure function (one
 * `Date.now()` per synthetic toolResult is the only impure bit).
 *
 * - `safe` → `{ kind: "none" }`.
 * - `mid-stream` → `{ kind: "mid-stream", replacementMessages: messages.slice(0, -1) }`.
 *   The trailing partial assistant message is dropped so the next
 *   `agent.continue()` re-asks the LLM from the prior history.
 * - `mid-tool` → `{ kind: "mid-tool", syntheticResults: [...] }` with one
 *   synthetic `toolResult` per pending id. Each result is `isError: true` and
 *   carries the literal `"interrupted by crash"` text. If the latest
 *   assistant message is missing (inconsistent log), returns `{ kind: "none" }`
 *   defensively rather than producing toolResults that point at no toolCall.
 */
export function decideRecoveryAction(
	crashState: CrashState,
	sessionMessages: readonly AgentMessage[],
	latestAssistantMessage: AssistantMessage | undefined,
): RecoveryAction {
	if (crashState.kind === "safe") return { kind: "none" };

	if (crashState.kind === "mid-stream") {
		if (sessionMessages.length === 0) return { kind: "none" };
		return { kind: "mid-stream", replacementMessages: sessionMessages.slice(0, -1) };
	}

	if (latestAssistantMessage === undefined) return { kind: "none" };

	const now = Date.now();
	const syntheticResults: ToolResultMessage[] = crashState.pendingToolCallIds.map(toolCallId => {
		const toolCall = findToolCallById(latestAssistantMessage, toolCallId);
		const toolName = toolCall?.name ?? UNKNOWN_TOOL_NAME;
		return {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: INTERRUPTED_TEXT }],
			isError: true,
			timestamp: now,
		};
	});

	if (syntheticResults.length === 0) return { kind: "none" };
	return { kind: "mid-tool", syntheticResults };
}

/**
 * Apply a `RecoveryAction` to an `Agent`. Trivial side-effect wrapper —
 * `replaceMessages` for `mid-stream`, one `appendMessage` per synthetic for
 * `mid-tool`, no-op for `none`.
 *
 * The caller (orchestrator or `createAgentSession`) is responsible for then
 * calling `agent.continue()` if the action was non-`none` and the agent should
 * resume.
 */
export function applyRecoveryAction(action: RecoveryAction, agent: AgentRecoveryFacade): void {
	switch (action.kind) {
		case "none":
			return;
		case "mid-stream":
			agent.replaceMessages([...action.replacementMessages]);
			return;
		case "mid-tool":
			for (const result of action.syntheticResults) {
				agent.appendMessage(result);
			}
			return;
	}
}

/**
 * Top-level orchestrator: classifies the crash state from the session log,
 * decides the recovery action, applies it to the agent, and returns the
 * applied action so the caller can decide whether to call `agent.continue()`.
 *
 * The classification helpers (`findLatestRecoveryMarker`, `classifyCrashState`,
 * `findLatestAssistantMessage`) live in `./recovery-policy.ts`; this driver
 * just wires them through.
 */
export function recoverIfNeeded(
	sessionEntries: readonly SessionEntry[],
	sessionMessages: readonly AgentMessage[],
	agent: AgentRecoveryFacade,
): RecoveryAction {
	const marker = findLatestRecoveryMarker(sessionEntries);
	const crashState = classifyCrashState(sessionEntries, marker);
	const latestAssistantMessage = findLatestAssistantMessage(sessionEntries);
	const action = decideRecoveryAction(crashState, sessionMessages, latestAssistantMessage);
	applyRecoveryAction(action, agent);
	return action;
}
