import { describe, expect, it } from "bun:test";
import { buildPrompt, messagesFromContext } from "@oh-my-pi/pi-ai/effect-ai-prompt-builder";
import type { AssistantMessage, Context, Usage } from "@oh-my-pi/pi-ai/types";
import { Type } from "@sinclair/typebox";

const zeroUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const baseAssistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "openai",
	model: "gpt-5",
	usage: zeroUsage(),
	stopReason: "stop",
	timestamp: 0,
});

describe("messagesFromContext — pi-ai Context -> Effect 4 MessageEncoded[]", () => {
	it("an empty context produces no messages", () => {
		expect(messagesFromContext({ messages: [] })).toEqual([]);
	});

	it("prepends a system message when systemPrompt is set and non-empty", () => {
		const out = messagesFromContext({ systemPrompt: "You are X.", messages: [] });
		expect(out).toEqual([{ role: "system", content: "You are X." }]);
	});

	it("skips systemPrompt when empty string (Effect 4 rejects empty system content)", () => {
		expect(messagesFromContext({ systemPrompt: "", messages: [] })).toEqual([]);
	});

	describe("user messages", () => {
		it("string content wraps into a single TextPart", () => {
			const out = messagesFromContext({
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			});
			expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
		});

		it("text + image content blocks map to text + file parts in order", () => {
			const out = messagesFromContext({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "What's this?" },
							{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
						],
						timestamp: 0,
					},
				],
			});
			expect(out[0]).toEqual({
				role: "user",
				content: [
					{ type: "text", text: "What's this?" },
					{ type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" },
				],
			});
		});
	});

	describe("developer messages — collapse onto system role", () => {
		it("string content maps to a system message", () => {
			const out = messagesFromContext({
				messages: [{ role: "developer", content: "Reasoning rules: …", timestamp: 0 }],
			});
			expect(out).toEqual([{ role: "system", content: "Reasoning rules: …" }]);
		});

		it("array content concatenates text + describes images as placeholders", () => {
			const out = messagesFromContext({
				messages: [
					{
						role: "developer",
						content: [
							{ type: "text", text: "preamble" },
							{ type: "image", data: "...", mimeType: "image/jpeg" },
							{ type: "text", text: "postamble" },
						],
						timestamp: 0,
					},
				],
			});
			expect(out[0]).toEqual({ role: "system", content: "preamble\n[image:image/jpeg]\npostamble" });
		});
	});

	describe("assistant messages", () => {
		it("text-only assistant content yields a single TextPart", () => {
			const out = messagesFromContext({
				messages: [baseAssistant([{ type: "text", text: "hi" }])],
			});
			expect(out).toEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
		});

		it("thinking content maps to reasoning parts", () => {
			const out = messagesFromContext({
				messages: [
					baseAssistant([
						{ type: "thinking", thinking: "step 1." },
						{ type: "text", text: "answer" },
					]),
				],
			});
			expect(out[0]).toEqual({
				role: "assistant",
				content: [
					{ type: "reasoning", text: "step 1." },
					{ type: "text", text: "answer" },
				],
			});
		});

		it("tool calls preserve id / name / arguments via the tool-call part", () => {
			const out = messagesFromContext({
				messages: [
					baseAssistant([
						{ type: "text", text: "calling" },
						{ type: "toolCall", id: "tc_1", name: "get_weather", arguments: { city: "NYC" } },
					]),
				],
			});
			expect(out[0]).toEqual({
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{ type: "tool-call", id: "tc_1", name: "get_weather", params: { city: "NYC" } },
				],
			});
		});

		it("redactedThinking blocks are dropped (no Effect 4 equivalent)", () => {
			const out = messagesFromContext({
				messages: [
					baseAssistant([
						{ type: "redactedThinking", data: "[redacted]" },
						{ type: "text", text: "OK" },
					]),
				],
			});
			expect(out[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "OK" }] });
		});

		it("empty assistant content is dropped entirely (Effect 4 prompt schema rejects empty assistant content)", () => {
			const out = messagesFromContext({
				messages: [
					baseAssistant([
						{ type: "text", text: "" },
						{ type: "thinking", thinking: "" },
					]),
				],
			});
			expect(out).toEqual([]);
		});
	});

	describe("tool result messages", () => {
		it("text content concatenates into a single tool-result part", () => {
			const out = messagesFromContext({
				messages: [
					{
						role: "toolResult",
						toolCallId: "tc_1",
						toolName: "get_weather",
						content: [{ type: "text", text: '{"temp":22}' }],
						isError: false,
						timestamp: 0,
					},
				],
			});
			expect(out[0]).toEqual({
				role: "tool",
				content: [
					{
						type: "tool-result",
						id: "tc_1",
						name: "get_weather",
						isFailure: false,
						result: '{"temp":22}',
					},
				],
			});
		});

		it("isError propagates to Effect 4's isFailure flag", () => {
			const out = messagesFromContext({
				messages: [
					{
						role: "toolResult",
						toolCallId: "tc_1",
						toolName: "get_weather",
						content: [{ type: "text", text: "rate limit" }],
						isError: true,
						timestamp: 0,
					},
				],
			});
			const part = out[0]?.role === "tool" ? out[0].content[0] : undefined;
			if (part?.type === "tool-result") expect(part.isFailure).toBe(true);
		});
	});

	describe("buildPrompt — top-level wrapper around Prompt.make", () => {
		it("returns a Prompt instance whose `content` matches the converted messages", () => {
			const prompt = buildPrompt({
				systemPrompt: "be brief",
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
			});
			expect(prompt.content).toHaveLength(2);
			const [system, user] = prompt.content;
			expect(system?.role).toBe("system");
			expect(user?.role).toBe("user");
		});

		it("accepts a context with tools but ignores them (tools belong on the toolkit option, not the prompt)", () => {
			const prompt = buildPrompt({
				systemPrompt: "x",
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
				tools: [{ name: "noop", description: "no", parameters: Type.Object({}) }],
			});
			expect(prompt.content).toHaveLength(2);
		});
	});
});
