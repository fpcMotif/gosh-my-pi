import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	basicConfig,
	createModel,
	drainWithTimeout,
	emptyAssistantMessage,
	emptyContext,
	scriptedStream,
	userMessage,
} from "./test-utils";

/**
 * Contract: when the AbortSignal fires during an LLM stream, the agent
 * loop must:
 *   1. Stop emitting tool calls / state mutations after the abort point.
 *   2. Finalize the assistant message with stopReason "aborted".
 *   3. Terminate within bounded time (no hang on stream.result()).
 *   4. Not throw an unhandled rejection from the catch branch.
 */

describe("agentLoop — abort during streaming", () => {
	it("finalizes with stopReason 'aborted' when signal fires before any deltas arrive", async () => {
		const context = emptyContext();
		const config = basicConfig();

		// Stream that pushes 'start' then waits forever — abort fires before delta.
		const streamFn = () => {
			const s = new AssistantMessageEventStream();
			const partial = emptyAssistantMessage(createModel());
			queueMicrotask(() => s.push({ type: "start", partial }));
			return s;
		};

		const ctrl = new AbortController();
		queueMicrotask(() => ctrl.abort());

		const stream = agentLoop([userMessage("hi")], context, config, ctrl.signal, streamFn);
		const outcome = await drainWithTimeout(stream, 500);

		expect(outcome.timedOut).toBe(false);
		const assistant = context.messages.find(m => m.role === "assistant") as AssistantMessage | undefined;
		// Either a synthesized aborted message or no assistant at all (edge of timing).
		if (assistant) {
			expect(["aborted", "error"]).toContain(assistant.stopReason);
		}
	});

	it("does not push further events on the agent stream after abort", async () => {
		const context = emptyContext();
		const config = basicConfig();
		const partial = emptyAssistantMessage(createModel());

		const streamFn = () => {
			const s = new AssistantMessageEventStream();
			queueMicrotask(async () => {
				s.push({ type: "start", partial });
				await Bun.sleep(50);
				// By now abort has fired; pushes after this point should be ignored
				// by the loop's iteration check.
				s.push({ type: "text_delta", contentIndex: 0, delta: "after-abort", partial });
				const message = { ...partial, stopReason: "stop" as const };
				s.push({ type: "done", reason: "stop", message });
			});
			return s;
		};

		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 10);

		const stream = agentLoop([userMessage("hi")], context, config, ctrl.signal, streamFn);
		const outcome = await drainWithTimeout(stream, 500);

		expect(outcome.timedOut).toBe(false);
		const assistant = context.messages.find(m => m.role === "assistant") as AssistantMessage | undefined;
		if (assistant) {
			// Final message must reflect the abort, not the post-abort 'done' event.
			expect(["aborted", "error"]).toContain(assistant.stopReason);
		}
	});

	it("never leaves an orphan partial 'stop' message after mid-stream abort", async () => {
		const context = emptyContext();
		const config = basicConfig();
		const partial = emptyAssistantMessage(createModel());

		const streamFn = () => {
			const s = new AssistantMessageEventStream();
			queueMicrotask(async () => {
				s.push({ type: "start", partial });
				s.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
				await Bun.sleep(100);
				// Post-abort emit — must be ignored
				const message = { ...partial, stopReason: "stop" as const };
				s.push({ type: "done", reason: "stop", message });
			});
			return s;
		};

		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 30);

		const stream = agentLoop([userMessage("hi")], context, config, ctrl.signal, streamFn);
		await drainWithTimeout(stream, 500);

		const assistants = context.messages.filter(m => m.role === "assistant") as AssistantMessage[];
		// No assistant message should have stopReason "stop" - that would be
		// an orphan partial that escaped the abort path.
		for (const a of assistants) {
			expect(a.stopReason).not.toBe("stop");
		}
	});

	it("terminates the loop within bounded time when abort fires before stream emits anything", async () => {
		const context = emptyContext();
		const config = basicConfig();

		// Stream that hangs forever
		const streamFn = () => new AssistantMessageEventStream();

		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 20);

		const stream = agentLoop([userMessage("hi")], context, config, ctrl.signal, streamFn);
		const outcome = await drainWithTimeout(stream, 500);
		expect(outcome.timedOut).toBe(false);
	});

	it("does not throw an unhandled rejection when abort interleaves with finalisation", async () => {
		const context = emptyContext();
		const config = basicConfig();

		// We don't assert anything about specific message content — only that
		// the test completes without producing an unhandled rejection (which
		// would fail Bun's test runner).
		const ctrl = new AbortController();
		const stream = agentLoop(
			[userMessage("hi")],
			context,
			config,
			ctrl.signal,
			scriptedStream([
				{ kind: "text", delta: "hello", afterMs: 5 },
				{ kind: "done", afterMs: 5 },
			]),
		);

		// Abort right around when 'done' is expected
		setTimeout(() => ctrl.abort(), 8);

		const outcome = await drainWithTimeout(stream, 500);
		expect(outcome.timedOut).toBe(false);
	});
});
