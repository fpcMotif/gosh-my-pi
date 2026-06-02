import { describe, expect, it } from "bun:test";
import { PostPromptScheduler, type PostPromptSchedulerContext } from "../src/session/post-prompt-scheduler";

function createControlledContext(): {
	calls: string[];
	setGeneration: (generation: number) => void;
	setRetryGate: () => { resolve: () => void };
	setTtsrGate: () => { resolve: () => void };
	setStreaming: (streaming: boolean) => void;
	resolveStreamingIdle: () => void;
	ctx: PostPromptSchedulerContext;
} {
	const calls: string[] = [];
	let generation = 1;
	let retry: { promise: Promise<void>; resolve: () => void } | undefined;
	let ttsr: { promise: Promise<void>; resolve: () => void } | undefined;
	let streaming = false;
	let streamingIdleResolve: (() => void) | undefined;

	const ctx: PostPromptSchedulerContext = {
		getPromptGeneration: () => generation,
		maybeRestorePrimary: async () => {
			calls.push("restore");
		},
		runAgentRequest: async () => {
			calls.push("continue");
		},
		getRetryPromise: () => retry?.promise,
		getTtsrResumePromise: () => ttsr?.promise,
		isStreaming: () => streaming,
		waitForAgentIdle: async () => {
			calls.push("waitForAgentIdle");
			const { promise, resolve } = Promise.withResolvers<void>();
			streamingIdleResolve = resolve;
			await promise;
			streamingIdleResolve = undefined;
		},
		resolveResume: () => {
			calls.push("resolveResume");
		},
	};

	return {
		calls,
		setGeneration: value => {
			generation = value;
		},
		setRetryGate: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			retry = { promise, resolve };
			return {
				resolve: () => {
					retry?.resolve();
					retry = undefined;
				},
			};
		},
		setTtsrGate: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			ttsr = { promise, resolve };
			return {
				resolve: () => {
					ttsr?.resolve();
					ttsr = undefined;
				},
			};
		},
		setStreaming: value => {
			streaming = value;
		},
		resolveStreamingIdle: () => {
			streamingIdleResolve?.();
		},
		ctx,
	};
}

describe("PostPromptScheduler", () => {
	it("schedules delayed tasks", async () => {
		const { ctx } = createControlledContext();
		const scheduler = new PostPromptScheduler(ctx);
		let ran = false;
		const started = performance.now();

		scheduler.schedulePostPromptTask(
			async () => {
				ran = true;
			},
			{ delayMs: 25 },
		);

		await Bun.sleep(10);
		expect(ran).toBe(false);

		await Bun.sleep(25);
		expect(ran).toBe(true);
		expect(performance.now() - started).toBeGreaterThanOrEqual(20);
	});

	it("skips tasks when prompt generation mismatches", async () => {
		const { ctx, setGeneration } = createControlledContext();
		setGeneration(2);
		const scheduler = new PostPromptScheduler(ctx);
		let ran = false;
		let skipped = 0;

		scheduler.schedulePostPromptTask(
			async () => {
				ran = true;
			},
			{ delayMs: 0, generation: 1, onSkip: () => skipped++ },
		);

		await Bun.sleep(10);
		expect(ran).toBe(false);
		expect(skipped).toBe(1);
	});

	it("cancels pending tasks on cancel", async () => {
		const { ctx } = createControlledContext();
		const scheduler = new PostPromptScheduler(ctx);
		let ran = false;
		let skipped = 0;

		scheduler.schedulePostPromptTask(
			async () => {
				ran = true;
			},
			{ delayMs: 50, onSkip: () => skipped++ },
		);

		await Bun.sleep(10);
		await scheduler.cancel();
		await Bun.sleep(10);

		expect(ran).toBe(false);
		expect(skipped).toBe(0);
	});

	it("tracks externally created post-prompt tasks", async () => {
		const { ctx } = createControlledContext();
		const scheduler = new PostPromptScheduler(ctx);
		const gate = Promise.withResolvers<void>();
		const tracked = gate.promise;
		scheduler.track(tracked);

		let recovered = false;
		const waitForRecovery = (async () => {
			await scheduler.waitForRecovery();
			recovered = true;
		})();

		await Bun.sleep(10);
		expect(recovered).toBe(false);

		gate.resolve();
		await waitForRecovery;
		expect(recovered).toBe(true);
	});

	it("waits on retry, ttsr, and streaming gates", async () => {
		const { ctx, setRetryGate, setTtsrGate, setStreaming, resolveStreamingIdle } = createControlledContext();
		const scheduler = new PostPromptScheduler(ctx);
		let recovered = false;
		setStreaming(true);
		const retryGate = setRetryGate();
		const ttsrGate = setTtsrGate();

		const waitForRecovery = (async () => {
			await scheduler.waitForRecovery();
			recovered = true;
		})();

		await Bun.sleep(10);
		expect(recovered).toBe(false);

		retryGate.resolve();
		await Bun.sleep(10);
		expect(recovered).toBe(false);

		ttsrGate.resolve();
		await Bun.sleep(10);
		expect(recovered).toBe(false);

		setStreaming(false);
		resolveStreamingIdle();
		await waitForRecovery;
		expect(recovered).toBe(true);
	});

	it("restores primary before continuing on scheduleAgentContinue", async () => {
		const calls: string[] = [];
		const ctx: PostPromptSchedulerContext = {
			getPromptGeneration: () => 1,
			maybeRestorePrimary: async () => {
				calls.push("restore");
			},
			runAgentRequest: async () => {
				calls.push("continue");
			},
			getRetryPromise: () => undefined,
			getTtsrResumePromise: () => undefined,
			isStreaming: () => false,
			waitForAgentIdle: async () => {},
			resolveResume: () => {},
		};
		const scheduler = new PostPromptScheduler(ctx);

		scheduler.scheduleAgentContinue();
		await Bun.sleep(10);

		expect(calls).toEqual(["restore", "continue"]);
	});
});
