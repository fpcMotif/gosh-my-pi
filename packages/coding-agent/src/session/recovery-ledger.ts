import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { RecoveryMarkerPayload } from "@oh-my-pi/pi-agent-core";
import type { SessionManager } from "./session-manager";
import { appendRecoveryMarker } from "./recovery-marker-live";

interface RecoveryLedgerContext {
	isRecoveryPolicyEnabled: () => boolean;
	appendRecoveryMarker: (payload: RecoveryMarkerPayload) => Promise<void>;
}

function defaultAppendRecoveryMarker(sessionManager: SessionManager): RecoveryLedgerContext["appendRecoveryMarker"] {
	return payload => appendRecoveryMarker(sessionManager, payload);
}

/**
 * Write-side owner for ADR-0003 recovery markers.
 *
 * It owns:
 * - the marker generation counter,
 * - the per-event sequence counter,
 * - pending tool-call IDs,
 * - append timing/format for recovery-marker entries.
 *
 * This Module does not mutate session state other than writing markers.
 */
export class RecoveryLedger {
	#ctx: RecoveryLedgerContext;
	#generation = 0;
	#eventSeq = 0;
	#pendingToolCallIds = new Set<string>();

	constructor(ctx: {
		isRecoveryPolicyEnabled: () => boolean;
		appendRecoveryMarker?: RecoveryLedgerContext["appendRecoveryMarker"];
	}) {
		this.#ctx = {
			isRecoveryPolicyEnabled: ctx.isRecoveryPolicyEnabled,
			appendRecoveryMarker: ctx.appendRecoveryMarker ?? (async () => undefined),
		};
	}

	/**
	 * Alternate constructor for the common session-manager pattern used by
	 * `AgentSession`.
	 */
	static fromSessionManager(options: {
		sessionManager: Pick<SessionManager, "appendRecoveryMarker">;
		isRecoveryPolicyEnabled: () => boolean;
	}): RecoveryLedger {
		return new RecoveryLedger({
			isRecoveryPolicyEnabled: options.isRecoveryPolicyEnabled,
			appendRecoveryMarker: defaultAppendRecoveryMarker(options.sessionManager),
		});
	}

	/**
	 * Call once at the start of each observed AgentEvent, before
	 * branch-specific handling.
	 */
	observeEventStart(): void {
		this.#eventSeq += 1;
	}

	/**
	 * Persist a marker after assistant messages that include tool calls are
	 * persisted. `isStreaming` is true for assistant message-end markers and
	 * drives the `mid-stream` recovery branch.
	 */
	async observeAssistantPersisted(message: AssistantMessage, isStreaming: boolean): Promise<void> {
		if (!this.#ctx.isRecoveryPolicyEnabled()) return;
		if (message.role !== "assistant") return;

		this.#pendingToolCallIds.clear();
		for (const content of message.content) {
			if (content.type === "toolCall") {
				this.#pendingToolCallIds.add(content.id);
			}
		}
		await this.#appendMarker(isStreaming);
	}

	/**
	 * Persist a marker when a tool call completes and removes that id from
	 * the pending set.
	 */
	async observeToolCompleted(toolCallId: string): Promise<void> {
		if (!this.#ctx.isRecoveryPolicyEnabled()) return;
		this.#pendingToolCallIds.delete(toolCallId);
		await this.#appendMarker(false);
	}

	/**
	 * Persist a marker at turn end and clear pending ids.
	 */
	async observeTurnCompleted(): Promise<void> {
		if (!this.#ctx.isRecoveryPolicyEnabled()) return;
		this.#pendingToolCallIds.clear();
		await this.#appendMarker(false);
	}

	#getState(): { generation: number; eventSeq: number; pendingToolCallIds: string[] } {
		return {
			generation: this.#generation,
			eventSeq: this.#eventSeq,
			pendingToolCallIds: [...this.#pendingToolCallIds],
		};
	}

	async #appendMarker(isStreaming: boolean): Promise<void> {
		this.#generation += 1;
		const payload: RecoveryMarkerPayload = {
			generation: this.#generation,
			lastEventSeq: this.#eventSeq,
			isStreaming,
			pendingToolCallIds: [...this.#pendingToolCallIds],
			timestamp: Date.now(),
		};
		await this.#ctx.appendRecoveryMarker(payload);
	}
}
