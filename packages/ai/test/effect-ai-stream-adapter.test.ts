import { describe, expect, it } from "bun:test";
import { toResponseStreamParts } from "@oh-my-pi/pi-ai/effect-ai-stream-adapter";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";

const emptyMessage = (): AssistantMessage => ({
	role: "assistant",
	content: [],
	stopReason: "stop",
	duration: 0,
});

describe("toResponseStreamParts — pi-ai AssistantMessageEvent -> Effect 4 Response.StreamPart", () => {
	it("`start` has no Effect 4 equivalent and emits zero parts", () => {
		const out = toResponseStreamParts({ type: "start", partial: emptyMessage() });
		expect(out).toEqual([]);
	});

	describe("text content", () => {
		it("`text_start` emits a single text-start with the contentIndex-derived id", () => {
			const out = toResponseStreamParts({
				type: "text_start",
				contentIndex: 0,
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("text-start");
			expect("id" in part ? part.id : undefined).toBe("pi-ai/text/0");
		});

		it("`text_delta` carries the same id and the original delta string", () => {
			const out = toResponseStreamParts({
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("text-delta");
			expect("id" in part ? part.id : undefined).toBe("pi-ai/text/0");
			expect("delta" in part ? part.delta : undefined).toBe("hello");
		});

		it("`text_end` correlates with its text_start by id", () => {
			const out = toResponseStreamParts({
				type: "text_end",
				contentIndex: 2,
				content: "full text",
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("text-end");
			expect("id" in part ? part.id : undefined).toBe("pi-ai/text/2");
		});
	});

	describe("thinking / reasoning content", () => {
		it("`thinking_start` -> reasoning-start with the reasoning-id prefix", () => {
			const out = toResponseStreamParts({
				type: "thinking_start",
				contentIndex: 0,
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("reasoning-start");
			expect("id" in part ? part.id : undefined).toBe("pi-ai/reasoning/0");
		});

		it("`thinking_delta` -> reasoning-delta with the same id and the delta", () => {
			const out = toResponseStreamParts({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "step 1",
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("reasoning-delta");
			expect("delta" in part ? part.delta : undefined).toBe("step 1");
		});

		it("`thinking_end` -> reasoning-end", () => {
			const out = toResponseStreamParts({
				type: "thinking_end",
				contentIndex: 1,
				content: "I conclude X.",
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("reasoning-end");
			expect("id" in part ? part.id : undefined).toBe("pi-ai/reasoning/1");
		});
	});

	describe("tool calls", () => {
		it("`toolcall_start` omits a part — Effect 4 needs the tool name, which is not yet known at start", () => {
			const out = toResponseStreamParts({
				type: "toolcall_start",
				contentIndex: 1,
				partial: emptyMessage(),
			});
			expect(out).toEqual([]);
		});

		it("`toolcall_delta` -> tool-params-delta with the contentIndex-derived id", () => {
			const out = toResponseStreamParts({
				type: "toolcall_delta",
				contentIndex: 1,
				delta: '{"city":"NY',
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("tool-params-delta");
			expect("id" in part ? part.id : undefined).toBe("pi-ai/tool/1");
			expect("delta" in part ? part.delta : undefined).toBe('{"city":"NY');
		});

		it("`toolcall_end` -> [tool-params-end, tool-call] preserving name and arguments", () => {
			const out = toResponseStreamParts({
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					type: "toolCall",
					id: "call_abc",
					name: "get_weather",
					arguments: { city: "NYC", units: "celsius" },
				},
				partial: emptyMessage(),
			});
			expect(out).toHaveLength(2);

			const [endPart, callPart] = out;
			expect(endPart?.type).toBe("tool-params-end");
			expect("id" in endPart! ? endPart.id : undefined).toBe("pi-ai/tool/1");

			expect(callPart?.type).toBe("tool-call");
			expect("id" in callPart! ? callPart.id : undefined).toBe("pi-ai/tool/1");
			expect("name" in callPart! ? callPart.name : undefined).toBe("get_weather");
			expect("params" in callPart! ? callPart.params : undefined).toEqual({ city: "NYC", units: "celsius" });
			expect("providerExecuted" in callPart! ? callPart.providerExecuted : undefined).toBe(false);
		});
	});

	describe("done", () => {
		it("`done` reason: 'stop' -> finish reason: 'stop' with usage carrying input/output token totals", () => {
			const out = toResponseStreamParts({
				type: "done",
				reason: "stop",
				message: {
					...emptyMessage(),
					usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 },
				},
			});
			expect(out).toHaveLength(1);
			const part = out[0]!;
			expect(part.type).toBe("finish");
			expect("reason" in part ? part.reason : undefined).toBe("stop");
			const usage = "usage" in part ? part.usage : undefined;
			expect(usage?.inputTokens.uncached).toBe(10);
			expect(usage?.inputTokens.cacheRead).toBe(2);
			expect(usage?.inputTokens.total).toBe(12); // input + cacheRead + cacheWrite
			expect(usage?.outputTokens.total).toBe(5);
		});

		it("`done` reason: 'length' -> finish reason: 'length'", () => {
			const out = toResponseStreamParts({
				type: "done",
				reason: "length",
				message: emptyMessage(),
			});
			expect("reason" in out[0]! ? out[0].reason : undefined).toBe("length");
		});

		it("`done` reason: 'toolUse' -> finish reason: 'tool-calls' (canonical Effect 4 spelling)", () => {
			const out = toResponseStreamParts({
				type: "done",
				reason: "toolUse",
				message: emptyMessage(),
			});
			expect("reason" in out[0]! ? out[0].reason : undefined).toBe("tool-calls");
		});

		it("`done` with reasoningTokens populates outputTokens.reasoning + derives outputTokens.text", () => {
			const out = toResponseStreamParts({
				type: "done",
				reason: "stop",
				message: {
					...emptyMessage(),
					usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 101, reasoningTokens: 40 },
				},
			});
			const usage = "usage" in out[0]! ? out[0].usage : undefined;
			expect(usage?.outputTokens.total).toBe(100);
			expect(usage?.outputTokens.reasoning).toBe(40);
			expect(usage?.outputTokens.text).toBe(60); // output - reasoning
		});
	});

	describe("error", () => {
		it("`error` -> [error, finish] so consumers see both the typed error and a stream terminator", () => {
			const errorMessage = { ...emptyMessage(), stopReason: "error" as const, errorMessage: "rate limit" };
			const out = toResponseStreamParts({
				type: "error",
				reason: "error",
				error: errorMessage,
			});
			expect(out).toHaveLength(2);

			const [errorPart, finishPart] = out;
			expect(errorPart?.type).toBe("error");
			expect("error" in errorPart! ? errorPart.error : undefined).toBe(errorMessage);

			expect(finishPart?.type).toBe("finish");
			expect("reason" in finishPart! ? finishPart.reason : undefined).toBe("error");
		});

		it("`error` reason: 'aborted' still surfaces as finish reason: 'error'", () => {
			const errorMessage = { ...emptyMessage(), stopReason: "aborted" as const };
			const out = toResponseStreamParts({
				type: "error",
				reason: "aborted",
				error: errorMessage,
			});
			expect(out).toHaveLength(2);
			expect("reason" in out[1]! ? out[1].reason : undefined).toBe("error");
		});
	});

	describe("id stability", () => {
		it("text-start / text-delta / text-end for the same contentIndex carry identical ids", () => {
			const start = toResponseStreamParts({ type: "text_start", contentIndex: 7, partial: emptyMessage() });
			const delta = toResponseStreamParts({
				type: "text_delta",
				contentIndex: 7,
				delta: "x",
				partial: emptyMessage(),
			});
			const end = toResponseStreamParts({
				type: "text_end",
				contentIndex: 7,
				content: "x",
				partial: emptyMessage(),
			});

			const id = (parts: ReadonlyArray<unknown>): string | undefined => {
				const head = parts[0];
				return head !== undefined && typeof head === "object" && head !== null && "id" in head
					? (head as { id?: string }).id
					: undefined;
			};
			expect(id(start)).toBe(id(delta));
			expect(id(delta)).toBe(id(end));
		});
	});
});
