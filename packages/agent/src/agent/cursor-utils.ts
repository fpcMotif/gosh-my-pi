import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { classifyAssistantError } from "../error-kind";
import type { AgentMessage, AgentEvent } from "../types";

export function emitCursorSplitAssistantMessage(
	assistantMessage: AssistantMessage,
	buffer: Array<{ toolResult: ToolResultMessage; textLengthAtCall: number }>,
	appendMessage: (m: AgentMessage) => void,
	emit: (e: AgentEvent) => void,
	clearStreamMessage: () => void,
): void {
	if (buffer.length === 0) {
		clearStreamMessage();
		appendMessage(assistantMessage);
		emit({ type: "message_end", message: assistantMessage, errorKind: classifyAssistantError(assistantMessage) });
		return;
	}

	const splitPoint = Math.min(...buffer.map(r => r.textLengthAtCall));
	const content = assistantMessage.content;
	let fullText = "";
	for (const block of content) {
		if (block.type === "text") fullText += block.text;
	}

	if (fullText.length === 0 || splitPoint <= 0 || splitPoint >= fullText.length) {
		clearStreamMessage();
		appendMessage(assistantMessage);
		emit({ type: "message_end", message: assistantMessage, errorKind: classifyAssistantError(assistantMessage) });
		for (const { toolResult } of buffer) {
			emit({ type: "message_start", message: toolResult });
			appendMessage(toolResult);
			emit({ type: "message_end", message: toolResult });
		}
		return;
	}

	const preambleText = fullText.slice(0, splitPoint);
	const continuationText = fullText.slice(splitPoint);

	const preambleMessage: AssistantMessage = {
		...assistantMessage,
		content: content.map(block => (block.type === "text" ? { ...block, text: preambleText } : block)),
	};

	clearStreamMessage();
	appendMessage(preambleMessage);
	emit({ type: "message_end", message: preambleMessage, errorKind: classifyAssistantError(preambleMessage) });

	for (const { toolResult } of buffer) {
		emit({ type: "message_start", message: toolResult });
		appendMessage(toolResult);
		emit({ type: "message_end", message: toolResult });
	}

	if (continuationText.trim().length > 0) {
		const continuationMessage: AssistantMessage = {
			...assistantMessage,
			content: [{ type: "text", text: continuationText }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		emit({ type: "message_start", message: continuationMessage });
		appendMessage(continuationMessage);
		emit({
			type: "message_end",
			message: continuationMessage,
			errorKind: classifyAssistantError(continuationMessage),
		});
	}
}
