import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { RecoveryMarkerPayload } from "@oh-my-pi/pi-agent-core";
import { fromPartial } from "@total-typescript/shoehorn";
import { RecoveryLedger } from "../src/session/recovery-ledger";

type Marker = RecoveryMarkerPayload;

function withRecordingWriter(): { markers: Marker[]; writer: (payload: Marker) => void } {
	const markers: Marker[] = [];

	return {
		markers,
		writer: marker => {
			markers.push({
				generation: marker.generation,
				lastEventSeq: marker.lastEventSeq,
				isStreaming: marker.isStreaming,
				pendingToolCallIds: [...marker.pendingToolCallIds],
				timestamp: marker.timestamp,
			});
		},
	};
}

function assistantMessage(ids: readonly string[]): AssistantMessage {
	return fromPartial<AssistantMessage>({
		role: "assistant",
		content: ids.map(id => ({
			type: "toolCall",
			id,
			name: "bash",
			arguments: {},
		})),
	});
}

describe("RecoveryLedger", () => {
	it("writes a streaming marker with pending tool-call IDs after assistant persistence", async () => {
		const { writer, markers } = withRecordingWriter();
		const ledger = new RecoveryLedger({
			isRecoveryPolicyEnabled: () => true,
			appendRecoveryMarker: async marker => {
				writer(marker);
			},
		});

		ledger.trackEvent();
		await ledger.observeAssistantMessageEnd(assistantMessage(["call-1", "call-2"]), true);

		expect(markers).toEqual([
			{
				generation: 1,
				lastEventSeq: 1,
				isStreaming: true,
				pendingToolCallIds: ["call-1", "call-2"],
				timestamp: expect.any(Number),
			},
		]);
	});

	it("removes completed tools before writing and clears pending at turn end", async () => {
		const { writer, markers } = withRecordingWriter();
		const ledger = new RecoveryLedger({
			isRecoveryPolicyEnabled: () => true,
			appendRecoveryMarker: async marker => {
				writer(marker);
			},
		});

		ledger.trackEvent();
		await ledger.observeAssistantMessageEnd(assistantMessage(["call-1", "call-2"]), false);
		ledger.trackEvent();
		await ledger.observeToolExecutionEnd("call-1");
		ledger.trackEvent();
		await ledger.observeTurnEnd();

		expect(markers).toHaveLength(3);
		expect(markers).toEqual([
			{
				generation: 1,
				lastEventSeq: 1,
				isStreaming: false,
				pendingToolCallIds: ["call-1", "call-2"],
				timestamp: expect.any(Number),
			},
			{
				generation: 2,
				lastEventSeq: 2,
				isStreaming: false,
				pendingToolCallIds: ["call-2"],
				timestamp: expect.any(Number),
			},
			{
				generation: 3,
				lastEventSeq: 3,
				isStreaming: false,
				pendingToolCallIds: [],
				timestamp: expect.any(Number),
			},
		]);
	});

	it("does nothing for non-assistant role messages", async () => {
		const { writer, markers } = withRecordingWriter();
		const ledger = new RecoveryLedger({
			isRecoveryPolicyEnabled: () => true,
			appendRecoveryMarker: async marker => {
				writer(marker);
			},
		});

		ledger.trackEvent();
		await ledger.observeAssistantMessageEnd(
			fromPartial<AssistantMessage>({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			}),
			true,
		);

		expect(markers).toEqual([]);
	});

	it("does not write anything when recovery policy is disabled", async () => {
		const { writer, markers } = withRecordingWriter();
		const ledger = new RecoveryLedger({
			isRecoveryPolicyEnabled: () => false,
			appendRecoveryMarker: async marker => {
				writer(marker);
			},
		});

		ledger.trackEvent();
		await ledger.observeAssistantMessageEnd(assistantMessage(["call-1"]), true);
		ledger.trackEvent();
		await ledger.observeToolExecutionEnd("call-1");
		ledger.trackEvent();
		await ledger.observeTurnEnd();

		expect(markers).toEqual([]);
	});
});
