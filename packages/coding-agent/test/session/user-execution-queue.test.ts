import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { UserExecutionQueue } from "../../src/session/user-execution-queue";

function message(content: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content, timestamp };
}

function createQueue(streaming: () => boolean) {
	const agentMessages: AgentMessage[] = [];
	const sessionMessages: AgentMessage[] = [];
	const queue = new UserExecutionQueue<AgentMessage>({
		agent: {
			appendMessage: entry => {
				agentMessages.push(entry);
			},
		},
		sessionManager: {
			appendMessage: entry => {
				sessionMessages.push(entry);
				return `stored-${sessionMessages.length}`;
			},
		},
		isStreaming: streaming,
	});
	return { agentMessages, queue, sessionMessages };
}

describe("UserExecutionQueue", () => {
	it("appends idle messages immediately and flushes streaming messages in order", () => {
		let streaming = false;
		const { agentMessages, queue, sessionMessages } = createQueue(() => streaming);

		queue.recordMessage(message("idle", 1));
		expect(agentMessages.map(entry => entry.content)).toEqual(["idle"]);
		expect(sessionMessages.map(entry => entry.content)).toEqual(["idle"]);
		expect(queue.hasPending).toBe(false);

		streaming = true;
		queue.recordMessage(message("first pending", 2));
		queue.recordMessage(message("second pending", 3));
		expect(queue.hasPending).toBe(true);
		expect(agentMessages.map(entry => entry.content)).toEqual(["idle"]);
		expect(sessionMessages.map(entry => entry.content)).toEqual(["idle"]);

		streaming = false;
		queue.flushPending();
		expect(queue.hasPending).toBe(false);
		expect(agentMessages.map(entry => entry.content)).toEqual(["idle", "first pending", "second pending"]);
		expect(sessionMessages.map(entry => entry.content)).toEqual(["idle", "first pending", "second pending"]);

		queue.flushPending();
		expect(agentMessages).toHaveLength(3);
		expect(sessionMessages).toHaveLength(3);
	});

	it("tracks runTracked executions, aborts their signal, and cleans up after settle", async () => {
		const { queue } = createQueue(() => false);
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<string>();

		const execution = queue.runTracked(async signal => {
			started.resolve(signal);
			return await release.promise;
		});
		const signal = await started.promise;

		expect(queue.isRunning).toBe(true);
		queue.abort();
		expect(signal.aborted).toBe(true);

		release.resolve("finished");
		await expect(execution).resolves.toBe("finished");
		expect(await queue.awaitSettlement(10)).toBe(true);
		expect(queue.isRunning).toBe(false);
	});

	it("waits for externally tracked executions and reports timeout before cleanup", async () => {
		const { queue } = createQueue(() => false);
		const abortController = new AbortController();
		const release = Promise.withResolvers<void>();

		const tracked = queue.track(release.promise, abortController);
		expect(queue.isRunning).toBe(true);
		expect(await queue.awaitSettlement(0)).toBe(false);
		expect(await queue.awaitSettlement(5)).toBe(false);

		queue.abort();
		expect(abortController.signal.aborted).toBe(true);

		release.resolve();
		await tracked;
		expect(await queue.awaitSettlement(10)).toBe(true);
		expect(queue.isRunning).toBe(false);
	});
});
