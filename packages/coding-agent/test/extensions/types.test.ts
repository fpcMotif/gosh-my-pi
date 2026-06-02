import { describe, expect, it } from "bun:test";
import { isToolCallEventType, type ToolCallEvent } from "../../src/extensibility/extensions/types";

describe("isToolCallEventType", () => {
	it("narrows tool-call events by their emitted tool name", () => {
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "pwd" },
		};

		expect(isToolCallEventType("bash", event)).toBe(true);
		expect(isToolCallEventType("read", event)).toBe(false);
	});
});
