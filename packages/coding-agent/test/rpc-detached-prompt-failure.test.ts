import { describe, expect, test } from "bun:test";
import { emitDetachedPromptFailure } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { WireFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/v1";

// A detached prompt that rejects after its synchronous ack must not vanish: the
// ack already resolved the command id, so a late errorResp reusing it is dropped
// by both reference clients. The failure is re-surfaced through the existing
// agent_end{errorKind:"fatal"} terminal vocabulary (gap G12).
describe("detached prompt failure", () => {
	test("surfaces a terminal agent_end with a fatal errorKind", () => {
		const frames: WireFrame[] = [];
		emitDetachedPromptFailure(frame => frames.push(frame), new Error("model gpt-9 not found"));

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ type: "agent_end", errorKind: { kind: "fatal" } });
	});

	test("carries no reused command id (empty agent_end messages, not an errorResp)", () => {
		const frames: WireFrame[] = [];
		emitDetachedPromptFailure(frame => frames.push(frame), new Error("boom"));

		const frame = frames[0];
		expect(frame.type).toBe("agent_end");
		if (frame.type === "agent_end") {
			expect(frame.messages).toEqual([]);
		}
	});
});
