import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { deriveAssistantStreamMessage } from "@oh-my-pi/pi-coding-agent/session/assistant-stream-message";

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("deriveAssistantStreamMessage", () => {
	it("returns assistantMessageEvent.message for done events", () => {
		const message = makeAssistantMessage("done payload");
		const evt: AssistantMessageEvent = { type: "done", reason: "stop", message };
		expect(deriveAssistantStreamMessage(evt)).toBe(message);
	});

	it("returns assistantMessageEvent.error for error events", () => {
		const error = makeAssistantMessage("error payload");
		const evt: AssistantMessageEvent = { type: "error", reason: "error", error };
		expect(deriveAssistantStreamMessage(evt)).toBe(error);
	});

	it("returns assistantMessageEvent.partial for streaming start", () => {
		const partial = makeAssistantMessage("partial-start");
		const evt: AssistantMessageEvent = { type: "start", partial };
		expect(deriveAssistantStreamMessage(evt)).toBe(partial);
	});

	it("returns assistantMessageEvent.partial for text_delta", () => {
		const partial = makeAssistantMessage("partial-delta");
		const evt: AssistantMessageEvent = {
			type: "text_delta",
			contentIndex: 0,
			delta: "x",
			partial,
		};
		expect(deriveAssistantStreamMessage(evt)).toBe(partial);
	});

	it("returns assistantMessageEvent.partial for thinking_delta", () => {
		const partial = makeAssistantMessage("partial-thinking");
		const evt: AssistantMessageEvent = {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "ponder",
			partial,
		};
		expect(deriveAssistantStreamMessage(evt)).toBe(partial);
	});

	it("returns assistantMessageEvent.partial for toolcall_delta", () => {
		const partial = makeAssistantMessage("partial-toolcall");
		const evt: AssistantMessageEvent = {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"a":',
			partial,
		};
		expect(deriveAssistantStreamMessage(evt)).toBe(partial);
	});

	it("returns assistantMessageEvent.partial for text_end (non-final non-error)", () => {
		const partial = makeAssistantMessage("partial-text-end");
		const evt: AssistantMessageEvent = {
			type: "text_end",
			contentIndex: 0,
			content: "ok",
			partial,
		};
		expect(deriveAssistantStreamMessage(evt)).toBe(partial);
	});

	it("never reads off a missing field — pre-fix two-arg signature would fail here", () => {
		// Pre b83fca9, agent-session.ts declared the interceptor as
		// (message, assistantMessageEvent) and the runtime invoked it with
		// a single argument. So `assistantMessageEvent` was always undefined
		// and any access through it would throw. This contract ensures the
		// helper consumes a single discriminated-union argument, matching
		// the runtime's call shape.
		const partial = makeAssistantMessage("contract");
		const evt: AssistantMessageEvent = { type: "start", partial };
		expect(() => deriveAssistantStreamMessage(evt)).not.toThrow();
		expect(deriveAssistantStreamMessage.length).toBe(1);
	});
});
