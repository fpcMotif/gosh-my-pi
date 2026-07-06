import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function makeKimiForCodingModel(): Model<"openai-completions"> {
	return {
		id: "kimi-for-coding",
		name: "Kimi For Coding",
		api: "openai-completions",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_000,
		reasoning: true,
		compat: {
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
	};
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] };
}

function sseDoneResponse(): Response {
	const sse = "data: [DONE]\n\n";
	return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("kimi-for-coding wire payload", () => {
	it("omits the thinking field instead of sending disabled", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		global.fetch = vi.fn(async () => sseDoneResponse()) as unknown as typeof fetch;

		const stream = streamOpenAICompletions(makeKimiForCodingModel(), makeContext(), {
			apiKey: "test-key",
			onPayload: payload => resolve(payload),
		});
		// Drain to completion so the async producer settles.
		for await (const _event of stream) {
			// no-op; we only need the captured payload
		}

		const payload = (await promise) as Record<string, unknown>;
		expect("thinking" in payload).toBe(false);
	});

	it("still sends thinking enabled when reasoning is requested", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		global.fetch = vi.fn(async () => sseDoneResponse()) as unknown as typeof fetch;

		const stream = streamOpenAICompletions(makeKimiForCodingModel(), makeContext(), {
			apiKey: "test-key",
			reasoning: "high",
			onPayload: payload => resolve(payload),
		});
		for await (const _event of stream) {
			// no-op
		}

		const payload = (await promise) as { thinking?: { type: string } };
		expect(payload.thinking).toEqual({ type: "enabled" });
	});
});

describe("supportsForcedToolChoice downgrade on the wire", () => {
	it("downgrades forced tool_choice to auto when supportsForcedToolChoice is false", async () => {
		const model: Model<"openai-completions"> = {
			...makeKimiForCodingModel(),
			compat: { ...makeKimiForCodingModel().compat, supportsForcedToolChoice: false },
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		global.fetch = vi.fn(async () => sseDoneResponse()) as unknown as typeof fetch;

		const stream = streamOpenAICompletions(model, makeContext(), {
			apiKey: "test-key",
			toolChoice: { type: "tool", name: "read" },
			onPayload: payload => resolve(payload),
		});
		for await (const _event of stream) {
			// no-op
		}

		const payload = (await promise) as { tool_choice?: unknown };
		expect(payload.tool_choice).toBe("auto");
	});

	it("keeps forced tool_choice when supportsForcedToolChoice is true (default)", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		global.fetch = vi.fn(async () => sseDoneResponse()) as unknown as typeof fetch;

		const stream = streamOpenAICompletions(makeKimiForCodingModel(), makeContext(), {
			apiKey: "test-key",
			toolChoice: { type: "tool", name: "read" },
			onPayload: payload => resolve(payload),
		});
		for await (const _event of stream) {
			// no-op
		}

		const payload = (await promise) as { tool_choice?: unknown };
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "read" } });
	});
});
