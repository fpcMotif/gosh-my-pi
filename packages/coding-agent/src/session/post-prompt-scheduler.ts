import { abortableSleep } from "@oh-my-pi/pi-utils";

export interface PostPromptSchedulerContext {
	getPromptGeneration: () => number;
	maybeRestorePrimary: () => Promise<void>;
	runAgentRequest: () => Promise<void>;
	getRetryPromise: () => Promise<void> | undefined;
	getTtsrResumePromise: () => Promise<void> | undefined;
	isStreaming: () => boolean;
	waitForAgentIdle: () => Promise<void>;
	resolveResume: () => void;
}

export interface PostPromptSchedulerOptions {
	delayMs?: number;
	generation?: number;
	onSkip?: () => void;
}

export interface ScheduleAgentContinueOptions {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: () => void;
	onError?: (error: unknown) => void;
}

/**
 * Owns delayed continuation and post-prompt recovery gating.
 *
 * This module tracks deferred continuation tasks, cancellation, and wait gates
 * (`retry`, `ttsr` resume, and post-prompt tasks) so callers can coordinate
 * shutdown/idle behavior without owning these fields directly.
 */
export class PostPromptScheduler {
	#ctx: PostPromptSchedulerContext;
	#tasks = new Set<Promise<void>>();
	#tasksPromise: Promise<void> | undefined = undefined;
	#tasksResolve: (() => void) | undefined = undefined;
	#tasksAbortController = new AbortController();

	constructor(ctx: PostPromptSchedulerContext) {
		this.#ctx = ctx;
	}

	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>, options?: PostPromptSchedulerOptions): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#tasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await abortableSleep(delayMs, signal);
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.();
				return;
			}
			if (options?.generation !== undefined && this.#ctx.getPromptGeneration() !== options.generation) {
				options.onSkip?.();
				return;
			}
			await task(signal);
		})();
		this.#trackTask(scheduled);
	}

	scheduleAgentContinue(options?: ScheduleAgentContinueOptions): void {
		this.schedulePostPromptTask(
			async () => {
				if (options?.shouldContinue && !options.shouldContinue()) {
					options.onSkip?.();
					return;
				}
				try {
					await this.#ctx.maybeRestorePrimary();
					await this.#ctx.runAgentRequest();
				} catch (error) {
					options?.onError?.(error);
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: options?.onSkip,
			},
		);
	}

	/** Cancel all pending post-prompt tasks and wait for known tasks to settle. */
	async cancel(): Promise<void> {
		this.#tasksAbortController.abort();
		this.#tasksAbortController = new AbortController();
		this.#ctx.resolveResume();
		const pending = Array.from(this.#tasks);
		if (pending.length === 0) {
			this.#resolveTasksPromise();
			return;
		}
		await Promise.allSettled(pending);
		if (this.#tasks.size === 0) {
			this.#resolveTasksPromise();
		}
	}

	/**
	 * Wait for in-flight retry, TTSR resume, post-prompt tasks, and any active
	 * streaming to settle. `runAgentRequest` paths can schedule nested retry/ttsr
	 * cycles; this loops until no gate remains open.
	 */
	async waitForRecovery(): Promise<void> {
		while (true) {
			const retryPromise = this.#ctx.getRetryPromise();
			if (retryPromise) {
				await retryPromise;
				continue;
			}
			const ttsrResume = this.#ctx.getTtsrResumePromise();
			if (ttsrResume) {
				await ttsrResume;
				continue;
			}
			if (this.#tasksPromise) {
				await this.#tasksPromise;
				continue;
			}
			if (this.#ctx.isStreaming()) {
				await this.#ctx.waitForAgentIdle();
				continue;
			}
			break;
		}
	}

	#ensureTasksPromise(): void {
		if (this.#tasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#tasksPromise = promise;
		this.#tasksResolve = resolve;
	}

	#resolveTasksPromise(): void {
		if (!this.#tasksResolve) return;
		this.#tasksResolve();
		this.#tasksResolve = undefined;
		this.#tasksPromise = undefined;
	}

	#trackTask(task: Promise<void>): void {
		this.#tasks.add(task);
		this.#ensureTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#tasks.delete(task);
				if (this.#tasks.size === 0) {
					this.#resolveTasksPromise();
				}
			});
	}

	/**
	 * Track an externally-created post-prompt promise for wait accounting.
	 */
	track(task: Promise<void>): void {
		this.#trackTask(task);
	}
}
