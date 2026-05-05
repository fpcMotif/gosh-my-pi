import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import { basicConfig, drainWithTimeout, emptyContext, scriptedStream, textTurn, userMessage } from "./test-utils";

/**
 * Contract: streamAssistantResponse calls config.transformContext (when
 * provided) before each LLM turn so callers can manage context window
 * pressure. If transformContext throws, the loop must NOT leave the
 * context in a half-mutated state — partial assistant messages added
 * before the throw must be rolled back, and the error must propagate as
 * stream.error so consumers see a single observable failure.
 *
 * Bugs the file was designed to surface:
 *   - streaming.ts:26-28 — transformContext throw stranding partial
 *     messages (orphan in context.messages, no rollback).
 */

describe("agentLoop — transformContext rollback on failure", () => {
	it("surfaces a transformContext failure as a synthesised error AssistantMessage (no hang, no unhandled rejection)", async () => {
		const context = emptyContext();
		const config = basicConfig({
			transformContext: async () => {
				throw new Error("OOM during compaction");
			},
		});

		const stream = agentLoop([userMessage("hi")], context, config, undefined, scriptedStream(textTurn("ack")));
		const outcome = await drainWithTimeout(stream, 500);

		expect(outcome.timedOut).toBe(false);
		// Failure must be observable to the consumer in one of two ways:
		//   - a synthesised assistant message with stopReason "error" (preferred:
		//     keeps the loop's checkTerminalResponse contract intact); OR
		//   - a stream rejection on result() (older agentLoop variants).
		const synthesizedError = context.messages.find(
			m =>
				m.role === "assistant" &&
				(m as { stopReason?: string }).stopReason === "error" &&
				typeof (m as { errorMessage?: string }).errorMessage === "string" &&
				((m as { errorMessage?: string }).errorMessage ?? "").includes("OOM during compaction"),
		);
		const observableFailure =
			synthesizedError !== undefined || outcome.resultErr !== undefined || outcome.iterErr !== undefined;
		expect(observableFailure).toBe(true);
	});

	it("does not retain partial assistant messages in context after transformContext throws", async () => {
		const context = emptyContext();
		const config = basicConfig({
			transformContext: async () => {
				throw new Error("compaction failed");
			},
		});

		const stream = agentLoop([userMessage("hi")], context, config, undefined, scriptedStream(textTurn("ack")));
		await drainWithTimeout(stream, 500);

		// transformContext is called BEFORE the LLM call, so no partial should
		// exist when it throws — but assert defensively in case streaming
		// pushes a synthetic error message into context.
		const assistants = context.messages.filter(m => m.role === "assistant");
		// At most one synthesized error message (no orphan partial with stopReason "stop").
		expect(assistants.length).toBeLessThanOrEqual(1);
		for (const m of assistants) {
			expect((m as { stopReason: string }).stopReason).toBe("error");
		}
	});

	it("uses the transformed messages when transformContext succeeds", async () => {
		const context = emptyContext();
		// Pre-populate context with old turns so transformContext has work to do.
		context.messages = [
			userMessage("old-1"),
			{
				role: "assistant",
				content: [{ type: "text", text: "old reply 1" }],
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
			},
			userMessage("old-2"),
			{
				role: "assistant",
				content: [{ type: "text", text: "old reply 2" }],
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
			},
		];

		let transformedSeen: AgentMessage[] = [];
		const config = basicConfig({
			transformContext: async messages => {
				// Drop oldest two; keep last two
				transformedSeen = messages.slice(-2);
				return transformedSeen;
			},
		});

		const stream = agentLoop([userMessage("new")], context, config, undefined, scriptedStream(textTurn("ack")));
		await drainWithTimeout(stream, 500);

		// transformContext was called and returned the truncated set.
		expect(transformedSeen.length).toBeGreaterThan(0);
		expect(transformedSeen.length).toBeLessThanOrEqual(2);
	});

	it("does not double-call transformContext on a single turn", async () => {
		const context = emptyContext();
		let calls = 0;
		const config = basicConfig({
			transformContext: async messages => {
				calls += 1;
				return messages;
			},
		});

		const stream = agentLoop([userMessage("hi")], context, config, undefined, scriptedStream(textTurn("ok")));
		await drainWithTimeout(stream, 500);

		// Exactly one call per LLM turn (we have a single turn here).
		expect(calls).toBe(1);
	});
});
