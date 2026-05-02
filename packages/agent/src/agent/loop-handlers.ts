import type { AgentEvent, AgentMessage } from "../types";

export function handleTurnEnd(
	event: Extract<AgentEvent, { type: "turn_end" }>,
	setError: (error: string | undefined) => void,
) {
	if (
		event.message.role === "assistant" &&
		event.message.errorMessage !== undefined &&
		event.message.errorMessage !== null &&
		event.message.errorMessage !== ""
	) {
		setError(event.message.errorMessage);
	}
}

export function handleToolExecutionStart(
	event: Extract<AgentEvent, { type: "tool_execution_start" }>,
	pendingToolCalls: Set<string>,
): Set<string> {
	const s = new Set(pendingToolCalls);
	s.add(event.toolCallId);
	return s;
}

export function handleToolExecutionEnd(
	event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	pendingToolCalls: Set<string>,
): Set<string> {
	const s = new Set(pendingToolCalls);
	s.delete(event.toolCallId);
	return s;
}

export function getAssistantTextLength(message: AgentMessage | null): number {
	if (message === null || message.role !== "assistant" || !Array.isArray(message.content)) {
		return 0;
	}
	let length = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			length += block.text.length;
		}
	}
	return length;
}
