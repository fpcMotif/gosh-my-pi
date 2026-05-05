import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	basicConfig,
	createModel,
	drainWithTimeout,
	emptyAssistantMessage,
	emptyContext,
	userMessage,
} from "./test-utils";

/**
 * Contract: when a provider stream signals failure — either by emitting an
 * `error` event or by having its async iterator throw mid-flight — the
 * agent loop must:
 *   1. Synthesise a terminal AssistantMessage with stopReason 'error' that
 *      includes the original error text in `errorMessage`.
 *   2. Emit exactly one turn_end event referencing that message.
 *   3. Never leak the failure as an unhandled rejection.
 */

describe("agentLoop — provider error finalisation", () => {
	it("preserves errorMessage when provider emits an error event", async () => {
		const context = emptyContext();
		const config = basicConfig();

		const streamFn = () => {
			const model = createModel();
			const partial = emptyAssistantMessage(model);
			const s = new AssistantMessageEventStream();
			queueMicrotask(() => {
				s.push({ type: "start", partial });
				queueMicrotask(() => {
					const errorMsg: AssistantMessage = {
						...partial,
						stopReason: "error",
						errorMessage: "rate-limited: retry in 30s",
					};
					s.push({ type: "error", reason: "error", error: errorMsg });
				});
			});
			return s;
		};

		const stream = agentLoop([userMessage("hi")], context, config, undefined, streamFn);
		await drainWithTimeout(stream, 500);

		const assistant = context.messages.find(m => m.role === "assistant") as AssistantMessage | undefined;
		expect(assistant).toBeDefined();
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toContain("rate-limited");
	});

	it("synthesises an error message when the async iterator throws mid-stream", async () => {
		const context = emptyContext();
		const config = basicConfig();

		// Build a custom iterable that throws on the second next() call.
		// This is the path that streaming.ts's try/catch must catch.
		const streamFn = () => {
			const model = createModel();
			const partial = emptyAssistantMessage(model);
			let calls = 0;
			const fakeIterable: AsyncIterable<AssistantMessageEvent> = {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						calls += 1;
						if (calls === 1) {
							return { done: false, value: { type: "start", partial } satisfies AssistantMessageEvent };
						}
						throw new Error("network died");
					},
				}),
			};
			// Wrap fakeIterable in something the streamFn signature accepts.
			// AssistantMessageEventStream + a Symbol.asyncIterator override is
			// the simplest way; tests that need this pattern can do the same.
			const stream = new AssistantMessageEventStream();
			(stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<AssistantMessageEvent> })[
				Symbol.asyncIterator
			] = fakeIterable[Symbol.asyncIterator].bind(fakeIterable);
			return stream;
		};

		const stream = agentLoop([userMessage("hi")], context, config, undefined, streamFn);
		await drainWithTimeout(stream, 500);

		const assistant = context.messages.find(m => m.role === "assistant") as AssistantMessage | undefined;
		expect(assistant).toBeDefined();
		expect(assistant?.stopReason).toBe("error");
		// errorMessage must include the original throw's text so the UI/LLM
		// can display a meaningful diagnostic.
		expect((assistant?.errorMessage ?? "").length).toBeGreaterThan(0);
		expect(assistant?.errorMessage).toContain("network died");
	});

	it("emits exactly one turn_end event referencing the error message", async () => {
		const context = emptyContext();
		const config = basicConfig();

		const streamFn = () => {
			const model = createModel();
			const partial = emptyAssistantMessage(model);
			const s = new AssistantMessageEventStream();
			queueMicrotask(() => {
				s.push({ type: "start", partial });
				queueMicrotask(() => {
					const errorMsg: AssistantMessage = {
						...partial,
						stopReason: "error",
						errorMessage: "provider down",
					};
					s.push({ type: "error", reason: "error", error: errorMsg });
				});
			});
			return s;
		};

		const stream = agentLoop([userMessage("hi")], context, config, undefined, streamFn);
		const outcome = await drainWithTimeout(stream, 500);

		const turnEnds = outcome.events.filter(
			(e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end",
		);
		expect(turnEnds.length).toBe(1);
		expect(turnEnds[0].message.role).toBe("assistant");
		const msg = turnEnds[0].message as AssistantMessage;
		expect(msg.stopReason).toBe("error");
	});
});
