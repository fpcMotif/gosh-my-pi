import { describe, expect, it } from "bun:test";
import { Response } from "@oh-my-pi/pi-ai/effect-ai";
import { ResponseStreamAccumulator } from "@oh-my-pi/pi-ai/effect-ai-stream-accumulator";

const seed = { api: "openai-responses" as const, provider: "openai" as const, model: "gpt-5", timestamp: 1_000 };

const emptyUsagePart = (reason: "stop" | "length" | "tool-calls" | "error" = "stop"): Response.FinishPart =>
	Response.makePart("finish", {
		reason,
		usage: new Response.Usage({
			inputTokens: { uncached: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 0, text: undefined, reasoning: undefined },
		}),
		response: undefined,
	});

describe("ResponseStreamAccumulator — Effect 4 Response.AnyPart -> pi-ai AssistantMessageEvent", () => {
	it("emits a single `start` event on the first feed and never re-emits", () => {
		const acc = new ResponseStreamAccumulator(seed);
		const first = acc.feed(Response.makePart("text-start", { id: "t1" }));
		const second = acc.feed(Response.makePart("text-delta", { id: "t1", delta: "x" }));

		expect(first.map(e => e.type)).toEqual(["start", "text_start"]);
		expect(second.map(e => e.type)).toEqual(["text_delta"]);
	});

	describe("text", () => {
		it("text-start opens a TextContent block at the next content index", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("text-start", { id: "t1" }));

			expect(acc.partial.content).toEqual([{ type: "text", text: "" }]);
		});

		it("text-delta accumulates into the open block and emits text_delta with growing partial", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("text-start", { id: "t1" }));
			acc.feed(Response.makePart("text-delta", { id: "t1", delta: "hello " }));
			const events = acc.feed(Response.makePart("text-delta", { id: "t1", delta: "world" }));

			expect(events.map(e => e.type)).toEqual(["text_delta"]);
			expect(acc.partial.content).toEqual([{ type: "text", text: "hello world" }]);
		});

		it("text-end emits text_end carrying the full accumulated content", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("text-start", { id: "t1" }));
			acc.feed(Response.makePart("text-delta", { id: "t1", delta: "abc" }));
			const events = acc.feed(Response.makePart("text-end", { id: "t1" }));

			const end = events.find(e => e.type === "text_end");
			expect(end).toBeDefined();
			if (end?.type === "text_end") {
				expect(end.content).toBe("abc");
			}
		});

		it("text-delta on a never-started id implicitly opens the block (Effect 4's contract)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("text-delta", { id: "t1", delta: "x" }));
			expect(acc.partial.content).toEqual([{ type: "text", text: "x" }]);
		});

		it("two distinct text ids materialise two TextContent blocks at distinct content indices", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("text-start", { id: "t1" }));
			acc.feed(Response.makePart("text-start", { id: "t2" }));

			expect(acc.partial.content).toEqual([
				{ type: "text", text: "" },
				{ type: "text", text: "" },
			]);
		});
	});

	describe("reasoning / thinking", () => {
		it("reasoning-start opens a ThinkingContent block", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("reasoning-start", { id: "r1" }));
			expect(acc.partial.content).toEqual([{ type: "thinking", thinking: "" }]);
		});

		it("reasoning-delta accumulates into the open thinking block", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("reasoning-start", { id: "r1" }));
			acc.feed(Response.makePart("reasoning-delta", { id: "r1", delta: "step 1." }));
			acc.feed(Response.makePart("reasoning-delta", { id: "r1", delta: " step 2." }));
			expect(acc.partial.content).toEqual([{ type: "thinking", thinking: "step 1. step 2." }]);
		});

		it("reasoning-end emits thinking_end with the final content", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("reasoning-start", { id: "r1" }));
			acc.feed(Response.makePart("reasoning-delta", { id: "r1", delta: "abc" }));
			const events = acc.feed(Response.makePart("reasoning-end", { id: "r1" }));
			const end = events.find(e => e.type === "thinking_end");
			expect(end?.type).toBe("thinking_end");
			if (end?.type === "thinking_end") expect(end.content).toBe("abc");
		});
	});

	describe("tool calls", () => {
		it("tool-params-start opens a ToolCall block carrying the tool name", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("tool-params-start", { id: "tc1", name: "get_weather", providerExecuted: false }));
			expect(acc.partial.content).toEqual([{ type: "toolCall", id: "tc1", name: "get_weather", arguments: {} }]);
		});

		it("tool-params-delta emits toolcall_delta but does NOT mutate ToolCall.arguments (pi-ai waits for tool-call)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("tool-params-start", { id: "tc1", name: "get_weather", providerExecuted: false }));
			const events = acc.feed(Response.makePart("tool-params-delta", { id: "tc1", delta: '{"city":"N' }));
			expect(events.find(e => e.type === "toolcall_delta")?.type).toBe("toolcall_delta");
			expect(acc.partial.content[0]).toEqual({ type: "toolCall", id: "tc1", name: "get_weather", arguments: {} });
		});

		it("tool-params-end is informational (no pi-ai event) — pi-ai materialises at tool-call", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("tool-params-start", { id: "tc1", name: "get_weather", providerExecuted: false }));
			const events = acc.feed(Response.makePart("tool-params-end", { id: "tc1" }));
			expect(events).toEqual([]);
		});

		it("tool-call materialises arguments from params and emits toolcall_end", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(Response.makePart("tool-params-start", { id: "tc1", name: "get_weather", providerExecuted: false }));
			const events = acc.feed(
				Response.makePart("tool-call", {
					id: "tc1",
					name: "get_weather",
					params: { city: "NYC", units: "celsius" },
					providerExecuted: false,
				}),
			);
			expect(events.map(e => e.type)).toEqual(["toolcall_end"]);
			const end = events.find(e => e.type === "toolcall_end");
			if (end?.type === "toolcall_end") {
				expect(end.toolCall).toEqual({
					type: "toolCall",
					id: "tc1",
					name: "get_weather",
					arguments: { city: "NYC", units: "celsius" },
				});
			}
		});

		it("tool-call without prior tool-params-start still opens the block (resilient to skipped starts)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(
				Response.makePart("tool-call", {
					id: "tc1",
					name: "get_weather",
					params: { city: "NYC" },
					providerExecuted: false,
				}),
			);
			expect(acc.partial.content[0]).toMatchObject({ type: "toolCall", name: "get_weather" });
			expect(events.find(e => e.type === "toolcall_end")).toBeDefined();
		});

		it("non-record `params` falls back to an empty arguments object (no `as` cast required)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(
				Response.makePart("tool-call", {
					id: "tc1",
					name: "weird_tool",
					params: "raw string params",
					providerExecuted: false,
				}),
			);
			expect(events.find(e => e.type === "toolcall_end")?.type).toBe("toolcall_end");
			const block = acc.partial.content[0];
			if (block?.type === "toolCall") expect(block.arguments).toEqual({});
		});
	});

	describe("finish", () => {
		it("finish reason 'stop' -> pi-ai 'done' with stopReason 'stop'", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(emptyUsagePart("stop"));
			expect(events.find(e => e.type === "done")?.type).toBe("done");
			expect(acc.partial.stopReason).toBe("stop");
		});

		it("finish reason 'length' -> done with stopReason 'length'", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(emptyUsagePart("length"));
			expect(acc.partial.stopReason).toBe("length");
		});

		it("finish reason 'tool-calls' -> done with stopReason 'toolUse' (canonical pi-ai spelling)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(emptyUsagePart("tool-calls"));
			const done = events.find(e => e.type === "done");
			if (done?.type === "done") expect(done.reason).toBe("toolUse");
		});

		it("finish reason 'error' -> pi-ai 'error' event, NOT 'done'", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(emptyUsagePart("error"));
			expect(events.map(e => e.type)).toEqual(["start", "error"]);
		});

		it("finish.usage projects onto pi-ai's Usage shape (input/output/cache + totalTokens)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			acc.feed(
				Response.makePart("finish", {
					reason: "stop",
					usage: new Response.Usage({
						inputTokens: { uncached: 100, total: 105, cacheRead: 5, cacheWrite: 0 },
						outputTokens: { total: 50, text: 30, reasoning: 20 },
					}),
					response: undefined,
				}),
			);
			expect(acc.partial.usage).toMatchObject({
				input: 100,
				output: 50,
				cacheRead: 5,
				cacheWrite: 0,
				reasoningTokens: 20,
				totalTokens: 155,
			});
		});
	});

	describe("error", () => {
		it("error part with a string payload sets errorMessage and emits pi-ai 'error'", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(Response.makePart("error", { error: "rate limit hit" }));
			expect(events.find(e => e.type === "error")?.type).toBe("error");
			expect(acc.partial.errorMessage).toBe("rate limit hit");
			expect(acc.partial.stopReason).toBe("error");
		});

		it("error part with a non-string payload still emits pi-ai 'error' without errorMessage", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const cause = new Error("oops");
			const events = acc.feed(Response.makePart("error", { error: cause }));
			expect(events.find(e => e.type === "error")?.type).toBe("error");
			expect(acc.partial.errorMessage).toBeUndefined();
		});
	});

	describe("round-trip realistic stream", () => {
		it("text → tool call → finish reproduces a coherent partial across the whole sequence", () => {
			const acc = new ResponseStreamAccumulator(seed);

			acc.feed(Response.makePart("text-start", { id: "t1" }));
			acc.feed(Response.makePart("text-delta", { id: "t1", delta: "I'll check the weather. " }));
			acc.feed(Response.makePart("text-end", { id: "t1" }));

			acc.feed(Response.makePart("tool-params-start", { id: "tc1", name: "get_weather", providerExecuted: false }));
			acc.feed(Response.makePart("tool-params-delta", { id: "tc1", delta: '{"city":"' }));
			acc.feed(Response.makePart("tool-params-delta", { id: "tc1", delta: 'NYC"}' }));
			acc.feed(Response.makePart("tool-params-end", { id: "tc1" }));
			acc.feed(
				Response.makePart("tool-call", {
					id: "tc1",
					name: "get_weather",
					params: { city: "NYC" },
					providerExecuted: false,
				}),
			);

			acc.feed(
				Response.makePart("finish", {
					reason: "tool-calls",
					usage: new Response.Usage({
						inputTokens: { uncached: 20, total: 20, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 8, text: undefined, reasoning: undefined },
					}),
					response: undefined,
				}),
			);

			expect(acc.partial.content).toEqual([
				{ type: "text", text: "I'll check the weather. " },
				{ type: "toolCall", id: "tc1", name: "get_weather", arguments: { city: "NYC" } },
			]);
			expect(acc.partial.stopReason).toBe("toolUse");
			expect(acc.partial.usage.input).toBe(20);
			expect(acc.partial.usage.output).toBe(8);
		});
	});

	describe("informational parts", () => {
		it("response-metadata is silently dropped (no pi-ai event)", () => {
			const acc = new ResponseStreamAccumulator(seed);
			const events = acc.feed(
				Response.makePart("response-metadata", {
					id: "rmd",
					modelId: "gpt-5",
					timestamp: undefined,
					request: undefined,
				}),
			);
			expect(events.map(e => e.type)).toEqual(["start"]);
		});
	});
});
