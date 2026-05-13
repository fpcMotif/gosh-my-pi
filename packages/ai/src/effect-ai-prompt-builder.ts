// pi-ai Context  ->  Effect 4 Prompt
//
// Pure conversion from pi-ai's `Context { systemPrompt, messages, tools }`
// onto Effect 4's `Prompt.RawInput`-compatible message array. The
// `streamOpenAIResponses` rewrite (next slice) calls
// `m.streamText({ prompt: buildPrompt(context) })` against the
// LanguageModel service.
//
// Role mapping:
//
//   pi-ai role            Effect 4 role
//   ---------------------------------------------
//   (context.systemPrompt) "system"     [prepended once at the head]
//   "user"                "user"
//   "developer"           "system"      [Effect 4 has no developer role]
//   "assistant"           "assistant"
//   "toolResult"          "tool"
//
// Content part mapping:
//
//   pi-ai content              Effect 4 part
//   ---------------------------------------------
//   TextContent                text         { text }
//   ImageContent               file         { data, mediaType }
//   ThinkingContent            reasoning    { text }
//   RedactedThinkingContent    (dropped — no equivalent)
//   ToolCall                   tool-call    { id, name, params }
//
// `ToolResultMessage` flattens its `content: (TextContent|ImageContent)[]`
// into a single `tool-result.result` field. Text parts are concatenated;
// image parts are described as `[image:mediaType]` markers (Effect 4's
// tool-result has no native image carrying yet).
//
// Returns the raw `MessageEncoded[]` separately from the built `Prompt` so
// unit tests can assert on the message array without prying into the
// Prompt protocol shape.

import type { MessageEncoded } from "effect/unstable/ai/Prompt";
import * as PromptModule from "effect/unstable/ai/Prompt";
import type {
	AssistantMessage,
	Context,
	DeveloperMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "./types";

const textPart = (text: string): { type: "text"; text: string } => ({ type: "text", text });

const filePartFromImage = (image: ImageContent): { type: "file"; data: string; mediaType: string } => ({
	type: "file",
	data: image.data,
	mediaType: image.mimeType,
});

const userPartsFromContent = (
	content: UserMessage["content"],
): ReadonlyArray<{ type: "text"; text: string } | { type: "file"; data: string; mediaType: string }> => {
	if (typeof content === "string") return [textPart(content)];
	const parts: Array<{ type: "text"; text: string } | { type: "file"; data: string; mediaType: string }> = [];
	for (const item of content) {
		if (item.type === "text") parts.push(textPart(item.text));
		else parts.push(filePartFromImage(item));
	}
	return parts;
};

const summariseDeveloperContent = (content: DeveloperMessage["content"]): string => {
	if (typeof content === "string") return content;
	return content.map(item => (item.type === "text" ? item.text : `[image:${item.mimeType}]`)).join("\n");
};

const summariseToolResultContent = (content: ToolResultMessage["content"]): string =>
	content.map(item => (item.type === "text" ? item.text : `[image:${item.mimeType}]`)).join("");

const assistantParts = (
	content: AssistantMessage["content"],
): ReadonlyArray<
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool-call"; id: string; name: string; params: unknown }
> => {
	const parts: Array<
		| { type: "text"; text: string }
		| { type: "reasoning"; text: string }
		| { type: "tool-call"; id: string; name: string; params: unknown }
	> = [];
	for (const item of content) {
		switch (item.type) {
			case "text":
				if (item.text.length > 0) parts.push(textPart(item.text));
				break;
			case "thinking":
				if (item.thinking.length > 0) parts.push({ type: "reasoning", text: item.thinking });
				break;
			case "redactedThinking":
				// No Effect 4 equivalent — drop.
				break;
			case "toolCall":
				parts.push(toolCallPart(item));
				break;
		}
	}
	return parts;
};

const toolCallPart = (call: ToolCall): { type: "tool-call"; id: string; name: string; params: unknown } => ({
	type: "tool-call",
	id: call.id,
	name: call.name,
	params: call.arguments,
});

const toMessageEncoded = (message: Message): MessageEncoded | undefined => {
	switch (message.role) {
		case "user":
			return { role: "user", content: userPartsFromContent(message.content) };
		case "developer":
			return { role: "system", content: summariseDeveloperContent(message.content) };
		case "assistant": {
			const parts = assistantParts(message.content);
			if (parts.length === 0) return undefined;
			return { role: "assistant", content: parts };
		}
		case "toolResult":
			return {
				role: "tool",
				content: [
					{
						type: "tool-result",
						id: message.toolCallId,
						name: message.toolName,
						isFailure: message.isError,
						result: summariseToolResultContent(message.content),
					},
				],
			};
	}
};

/**
 * Project a pi-ai `Context` onto an array of Effect 4 `MessageEncoded`
 * suitable for `Prompt.make`. Empty assistant messages (e.g. an aborted
 * turn that produced no content) are dropped because Effect 4's prompt
 * schema rejects empty assistant content.
 */
export const messagesFromContext = (context: Context): ReadonlyArray<MessageEncoded> => {
	const messages: MessageEncoded[] = [];
	if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: context.systemPrompt });
	}
	for (const message of context.messages) {
		const converted = toMessageEncoded(message);
		if (converted !== undefined) messages.push(converted);
	}
	return messages;
};

/**
 * Build an Effect 4 `Prompt` ready to pass to
 * `LanguageModel.streamText({ prompt: buildPrompt(context) })`.
 *
 * Caller note: pi-ai `Tool[]` definitions are not part of `Prompt` —
 * Effect 4 separates the tool surface (`toolkit` argument) from the
 * messages, so the tool conversion belongs in the call-site wrapper, not
 * here.
 */
export const buildPrompt = (context: Context): PromptModule.Prompt => PromptModule.make(messagesFromContext(context));
