import { describe, expect, it } from "bun:test";
import { LocalAbort } from "@oh-my-pi/pi-ai/errors";
import type { HttpShape, HttpStreamOpts } from "@oh-my-pi/pi-ai/layers/http";
import { HttpError } from "@oh-my-pi/pi-ai/layers/http";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effect } from "@oh-my-pi/pi-utils/effect";

function makeUnusedRequest(): HttpShape["request"] {
	return () => Effect.fail(new HttpError({ cause: new Error("unused"), url: "unused" }));
}

function makeStream<T>(events: readonly T[]): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator](): AsyncIterator<T> {
			for (const event of events) {
				yield event;
			}
		},
	};
}

function makeSuccessfulHttp<TEvent>(events: readonly TEvent[], calls: HttpStreamOpts<unknown>[]): HttpShape {
	return {
		request: makeUnusedRequest(),
		requestStream: <T>(opts: HttpStreamOpts<T>) => {
			calls.push(opts as HttpStreamOpts<unknown>);
			return Effect.succeed(makeStream(events) as AsyncIterable<T>);
		},
	};
}

function makeFailingHttp(error: LocalAbort, calls: HttpStreamOpts<unknown>[]): HttpShape {
	return {
		request: makeUnusedRequest(),
		requestStream: <T>(opts: HttpStreamOpts<T>) => {
			calls.push(opts as HttpStreamOpts<unknown>);
			return Effect.fail(error);
		},
	};
}

function makeResponsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		reasoning: false,
	};
}

function makeCompletionsModel(): Model<"openai-completions"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		reasoning: false,
	};
}

function makeCodexModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
		reasoning: true,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "You are concise.",
		messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
	};
}

async function finalMessage(
	stream: AsyncIterable<unknown> & { result(): Promise<AssistantMessage> },
): Promise<AssistantMessage> {
	for await (const _event of stream) {
		// Drain the stream so throttled deltas and final events settle.
	}
	return await stream.result();
}

describe("OpenAI providers Effect stream integration", () => {
	it("routes openai-responses through Http.requestStream with caller signal and first-event watchdog", async () => {
		const calls: HttpStreamOpts<unknown>[] = [];
		const controller = new AbortController();
		const events: readonly unknown[] = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hi" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const httpService = makeSuccessfulHttp(events, calls);

		const result = await finalMessage(
			streamOpenAIResponses(makeResponsesModel(), makeContext(), {
				apiKey: "test-key",
				httpService,
				signal: controller.signal,
				streamFirstEventTimeoutMs: 123,
			}),
		);

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hi");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.callerSignal).toBe(controller.signal);
		expect(calls[0]?.firstEventWatchdog).toEqual({ kind: "timeout", timeoutMs: 123 });
		expect(calls[0]?.label).toBe("OpenAI responses stream");
	});

	it("maps openai-responses LocalAbort to an error stop reason", async () => {
		const calls: HttpStreamOpts<unknown>[] = [];
		const result = await finalMessage(
			streamOpenAIResponses(makeResponsesModel(), makeContext(), {
				apiKey: "test-key",
				httpService: makeFailingHttp(new LocalAbort({ kind: "timeout", durationMs: 17 }), calls),
			}),
		);

		expect(calls).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream timeout after 17ms");
	});

	it("routes openai-completions through Http.requestStream with caller signal and first-event watchdog", async () => {
		const calls: HttpStreamOpts<unknown>[] = [];
		const controller = new AbortController();
		const events: readonly unknown[] = [
			{
				id: "chatcmpl_1",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			},
			{
				id: "chatcmpl_1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		];
		const httpService = makeSuccessfulHttp(events, calls);

		const result = await finalMessage(
			streamOpenAICompletions(makeCompletionsModel(), makeContext(), {
				apiKey: "test-key",
				httpService,
				signal: controller.signal,
				streamFirstEventTimeoutMs: 456,
			}),
		);

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hi");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.callerSignal).toBe(controller.signal);
		expect(calls[0]?.firstEventWatchdog).toEqual({ kind: "timeout", timeoutMs: 456 });
		expect(calls[0]?.label).toBe("OpenAI completions stream");
	});

	it("maps openai-completions LocalAbort to an error stop reason", async () => {
		const calls: HttpStreamOpts<unknown>[] = [];
		const result = await finalMessage(
			streamOpenAICompletions(makeCompletionsModel(), makeContext(), {
				apiKey: "test-key",
				httpService: makeFailingHttp(new LocalAbort({ kind: "idle", durationMs: 23 }), calls),
			}),
		);

		expect(calls).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream idle after 23ms");
	});

	it("routes openai-codex responses through Http.requestStream with caller signal and first-event watchdog", async () => {
		const calls: HttpStreamOpts<unknown>[] = [];
		const controller = new AbortController();
		const events: readonly unknown[] = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hi" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi" }],
				},
			},
			{
				type: "response.done",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const httpService = makeSuccessfulHttp(events, calls);
		const token = (() => {
			const payload = Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: "acc_test" },
				}),
				"utf8",
			).toBase64();
			return `aaa.${payload}.bbb`;
		})();

		const result = await finalMessage(
			streamOpenAICodexResponses(makeCodexModel(), makeContext(), {
				apiKey: token,
				httpService,
				signal: controller.signal,
				streamFirstEventTimeoutMs: 123,
			}),
		);

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hi");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.callerSignal).toBe(controller.signal);
		expect(calls[0]?.firstEventWatchdog).toEqual({ kind: "timeout", timeoutMs: 123 });
		expect(calls[0]?.label).toBe("OpenAI Codex SSE stream");
	});

	it("maps openai-codex LocalAbort to an error stop reason", async () => {
		const calls: HttpStreamOpts<unknown>[] = [];
		const token = (() => {
			const payload = Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: "acc_test" },
				}),
				"utf8",
			).toBase64();
			return `aaa.${payload}.bbb`;
		})();

		const result = await finalMessage(
			streamOpenAICodexResponses(makeCodexModel(), makeContext(), {
				apiKey: token,
				httpService: makeFailingHttp(new LocalAbort({ kind: "timeout", durationMs: 17 }), calls),
			}),
		);

		expect(calls).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Codex stream timeout after 17ms");
	});
});
