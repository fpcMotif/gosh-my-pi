import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { AgentMessage, AgentPromptOptions } from "../types";

export function preparePromptMessages(
	input: string | AgentMessage | AgentMessage[],
	imagesOrOptions?: ImageContent[] | AgentPromptOptions,
): AgentMessage[] {
	if (Array.isArray(input)) return input;
	if (typeof input === "string") {
		const images = Array.isArray(imagesOrOptions) ? imagesOrOptions : undefined;
		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) content.push(...images);
		return [{ role: "user", content, timestamp: Date.now() }];
	}
	return [input];
}

export function preparePromptOptions(
	input: string | AgentMessage | AgentMessage[],
	imagesOrOptions?: ImageContent[] | AgentPromptOptions,
	options?: AgentPromptOptions,
): AgentPromptOptions | undefined {
	if (Array.isArray(input)) return imagesOrOptions as AgentPromptOptions | undefined;
	if (typeof input === "string") {
		return Array.isArray(imagesOrOptions) ? options : (imagesOrOptions as AgentPromptOptions | undefined);
	}
	return imagesOrOptions as AgentPromptOptions | undefined;
}
