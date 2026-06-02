import { describe, expect, it } from "bun:test";
import type { RecoveryMarkerPayload } from "@oh-my-pi/pi-agent-core";
import { Effect, Exit } from "@oh-my-pi/pi-utils/effect";
import { appendRecoveryMarkerEffect } from "../src/session/recovery-marker-live";

const payload: RecoveryMarkerPayload = {
	generation: 2,
	lastEventSeq: 10,
	isStreaming: true,
	pendingToolCallIds: ["tool-a"],
	timestamp: 1_700_000_000_000,
};

describe("appendRecoveryMarkerEffect", () => {
	it("copies pending tool ids into the session recovery marker entry", async () => {
		const entries: Array<{
			generation: number;
			lastEventSeq: number;
			isStreaming: boolean;
			pendingToolCallIds: string[];
		}> = [];
		const sessionManager = {
			appendRecoveryMarker: (entry: {
				generation: number;
				lastEventSeq: number;
				isStreaming: boolean;
				pendingToolCallIds: string[];
			}) => {
				entries.push(entry);
				return "marker-id";
			},
		};

		const exit = await Effect.runPromiseExit(appendRecoveryMarkerEffect(sessionManager, payload));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(entries).toEqual([
			{
				generation: 2,
				lastEventSeq: 10,
				isStreaming: true,
				pendingToolCallIds: ["tool-a"],
			},
		]);
		expect(entries[0]?.pendingToolCallIds).not.toBe(payload.pendingToolCallIds);
	});

	it("maps session-manager append failures into the Effect failure channel", async () => {
		const sessionManager = {
			appendRecoveryMarker: () => {
				throw new Error("disk full");
			},
		};

		const exit = await Effect.runPromiseExit(appendRecoveryMarkerEffect(sessionManager, payload));

		expect(Exit.isFailure(exit)).toBe(true);
	});
});
