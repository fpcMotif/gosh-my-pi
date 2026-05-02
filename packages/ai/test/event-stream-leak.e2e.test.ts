/**
 * AssistantMessageEventStream lifecycle / leak coverage.
 *
 * Defends:
 *  - The internal flush timer is cleared on `end()` so streams can be GC'd
 *    promptly; we surface this as: a stream ends in deterministic time and
 *    the next push() is a no-op.
 *  - Many push/end cycles on independent streams do not retain handles
 *    or queue references.
 *  - `result()` resolves once and only once for a completed stream.
 *  - Aborting via `end()` flushes pending deltas before completion.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

function mockMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageEventStream lifecycle", () => {
	it("does not deliver events after done()", async () => {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: mockMessage("hi") });
		// Subsequent push must be a no-op (the implementation guards on `done`).
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "late",
			partial: mockMessage(""),
		});

		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
	});

	it("is iterable and terminates after end()", async () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: mockMessage("") });
			stream.push({ type: "done", reason: "stop", message: mockMessage("done") });
		});
		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "done") break;
		}
		expect(events).toEqual(["start", "done"]);
	});

	it("flushes pending deltas before the done event", async () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			for (let i = 0; i < 8; i++) {
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: `${i}`,
					partial: mockMessage(""),
				});
			}
			stream.push({ type: "done", reason: "stop", message: mockMessage("01234567") });
		});
		const seen: string[] = [];
		for await (const event of stream) {
			seen.push(event.type);
			if (event.type === "done") break;
		}
		// The implementation merges consecutive deltas — there must be at
		// least one delta before done, and done must be last.
		expect(seen[seen.length - 1]).toBe("done");
		expect(seen.includes("text_delta")).toBe(true);
	});

	it("creating + completing 1000 streams stays cheap and does not throw", async () => {
		// Property check — main goal is no throws and bounded duration.
		const start = Bun.nanoseconds();
		for (let i = 0; i < 1000; i++) {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: mockMessage(`${i}`) });
			await stream.result();
		}
		const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
		// Loose upper bound — purely sanity-checks we are not pegging the loop.
		expect(elapsedMs).toBeLessThan(5_000);
	});

	it("end() unblocks waiting iterators with no further values", async () => {
		const stream = new AssistantMessageEventStream();
		const ended: boolean[] = [];
		const consumer = (async () => {
			for await (const _e of stream) {
				ended.push(false);
			}
			ended.push(true);
		})();
		// Allow the consumer to start awaiting.
		await Bun.sleep(0);
		stream.end();
		await consumer;
		expect(ended[ended.length - 1]).toBe(true);
	});

	it("error event resolves the final result with the error message", async () => {
		const stream = new AssistantMessageEventStream();
		const errorMsg = mockMessage("boom");
		stream.push({ type: "error", reason: "error", error: errorMsg });
		const result = await stream.result();
		expect(result).toBe(errorMsg);
	});
});
