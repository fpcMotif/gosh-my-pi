import { describe, expect, it, vi } from "bun:test";
import type { AgentEvent } from "../src/extensibility/extensions";
import type { Message, TextContent } from "@oh-my-pi/pi-ai";
import { AgentEventRouter } from "../src/session/agent-event-router";
import { SecretObfuscator } from "../src/secrets/obfuscator";

describe("AgentEventRouter", () => {
	it("removes pending visible user queue entries before emitting message_start", async () => {
		const calls: string[] = [];

		const router = new AgentEventRouter({
			emitSessionEvent: async event => {
				calls.push(`emit:${event.type}`);
			},
			getUserMessageText: message => {
				if (typeof message.content === "string") return message.content;
				const text = message.content.filter((part): part is TextContent => part.type === "text").map(part => part.text);
				return text.join("");
			},
			removeVisibleQueuedMessage: messageText => {
				calls.push(`remove:${messageText}`);
			},
			getObfuscator: () => undefined,
		});

		await router.handle({
			type: "message_start",
			message: {
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		} as AgentEvent);

		expect(calls).toEqual(["remove:hello", "emit:message_start"]);
	});

	it("emits deobfuscated assistant content while preserving obfuscated source event", async () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "api-key-123", mode: "obfuscate" },
		]);
		const obfuscated = obfuscator.obfuscate("api-key-123");

		const emitted: AgentEvent[] = [];
		const message: Message = {
			role: "assistant",
			content: [{ type: "text", text: obfuscated }],
			api: "openai",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const router = new AgentEventRouter({
			emitSessionEvent: async event => {
				emitted.push(event);
			},
			getUserMessageText: () => "",
			removeVisibleQueuedMessage: vi.fn(),
			getObfuscator: () => obfuscator,
		});

		await router.handle({
			type: "message_end",
			message,
		} as AgentEvent);

		expect(emitted).toHaveLength(1);
		const emittedMessage = emitted[0]?.message as Message;
		expect(emittedMessage?.content?.[0]).toMatchObject({ type: "text", text: "api-key-123" });
		expect(message.content?.[0]).toMatchObject({ type: "text", text: obfuscated });
	});
});
