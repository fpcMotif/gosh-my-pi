import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	basicConfig,
	createModel,
	drainWithTimeout,
	emptyAssistantMessage,
	emptyContext,
	MockStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when a provider stream's async iterator finishes without ever
 * emitting a final 'done' or 'error' event, the agent loop must:
 *   1. Terminate within bounded time — never hang the consumer's for-await.
 *   2. Either reject result() OR finalize a synthesized assistant message
 *      with stopReason "error".
 *   3. Leave no orphan partial assistant message in context.messages.
 */

describe("agentLoop — provider stream ends without done/error event", () => {
	it("does not hang when streamFn returns a stream that ends with no final event", async () => {
		const context = emptyContext();
		const config = basicConfig();

		const streamFn = () => {
			const s = new MockStream();
			queueMicrotask(() => s.end());
			return s;
		};

		const stream = agentLoop([userMessage("hi")], context, config, undefined, streamFn);
		const outcome = await drainWithTimeout(stream, 500);
		expect(outcome.timedOut).toBe(false);
	});

	it("never leaves an orphan partial assistant message in context.messages", async () => {
		const context = emptyContext();
		const config = basicConfig();
		const partial = emptyAssistantMessage(createModel());

		const streamFn = () => {
			const s = new MockStream();
			queueMicrotask(() => {
				s.push({ type: "start", partial });
				queueMicrotask(() => {
					s.push({ type: "text_delta", contentIndex: 0, delta: "h", partial });
					queueMicrotask(() => s.end());
				});
			});
			return s;
		};

		const stream = agentLoop([userMessage("hi")], context, config, undefined, streamFn);
		await drainWithTimeout(stream, 500);

		const assistants = context.messages.filter(m => m.role === "assistant") as AssistantMessage[];
		expect(assistants.length).toBeLessThanOrEqual(1);
		if (assistants.length === 1) {
			expect(assistants[0].stopReason).toBe("error");
		}
	});

	it("signals failure via result() rejection or a turn_end with stopReason error", async () => {
		const context = emptyContext();
		const config = basicConfig();

		const streamFn = () => {
			const s = new MockStream();
			queueMicrotask(() => s.end());
			return s;
		};

		const stream = agentLoop([userMessage("hi")], context, config, undefined, streamFn);
		const outcome = await drainWithTimeout(stream, 500);
		expect(outcome.timedOut).toBe(false);

		const errorTurnEnd = outcome.events.find(
			(e): e is Extract<AgentEvent, { type: "turn_end" }> =>
				e.type === "turn_end" && e.message.role === "assistant" && e.message.stopReason === "error",
		);
		const failed = outcome.resultErr !== undefined || outcome.iterErr !== undefined || errorTurnEnd !== undefined;
		expect(failed).toBe(true);
	});
});
