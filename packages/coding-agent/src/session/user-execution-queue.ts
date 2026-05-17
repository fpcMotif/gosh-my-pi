import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Dependencies the {@link UserExecutionQueue} needs from its owner.
 */
export interface UserExecutionQueueContext<TMessage extends AgentMessage> {
	agent: { appendMessage(message: TMessage): void };
	sessionManager: { appendMessage(message: TMessage): string };
	isStreaming(): boolean;
}

/**
 * Shared streaming-deferred execution queue for user-initiated commands.
 *
 * Owns the three pieces of state {@link BashController} and {@link PythonController}
 * previously each carried independently:
 *
 * - **In-flight abort controllers** — a {@link Set} that {@link abort} can iterate over to
 *   cancel everything currently running.
 * - **Pending message buffer** — execution-result messages produced while the agent is
 *   streaming are held back until the next idle point so they do not interleave with
 *   the assistant's `tool_use`/`tool_result` pairs (which would break provider
 *   ordering invariants). {@link flushPending} drains the buffer before the next
 *   prompt.
 * - **Active execution Promises** — tracked so {@link awaitSettlement} can cooperatively
 *   wait during session disposal before aborting and trying again.
 *
 * The owning controller passes a context that knows how to append a final message to
 * agent state and the session log; everything else (the kernel, the bash executor,
 * extension hooks, options shapes) stays on the controller.
 */
export class UserExecutionQueue<TMessage extends AgentMessage> {
	#ctx: UserExecutionQueueContext<TMessage>;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: TMessage[] = [];
	#activeExecutions = new Set<Promise<unknown>>();

	constructor(ctx: UserExecutionQueueContext<TMessage>) {
		this.#ctx = ctx;
	}

	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	get hasPending(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/**
	 * Run an execution, supplying its abort signal. Registers the controller and the
	 * resulting promise so {@link abort} and {@link awaitSettlement} can act on both.
	 */
	runTracked<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const abortController = new AbortController();
		const execution = run(abortController.signal);
		return this.track(execution, abortController);
	}

	/**
	 * Track a Promise + AbortController pair started outside {@link runTracked}.
	 * Used when the execution must be constructed before the queue sees it
	 * (e.g. SDK consumers warming up the Python kernel during session setup).
	 */
	track<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#abortControllers.add(abortController);
		this.#activeExecutions.add(execution);
		const cleanup = (): void => {
			this.#abortControllers.delete(abortController);
			this.#activeExecutions.delete(execution);
		};
		void execution.then(cleanup, cleanup);
		return execution;
	}

	/**
	 * Persist a completed execution's result message. While the agent is streaming
	 * the message is buffered; otherwise it is appended directly to agent state and
	 * the session log.
	 */
	recordMessage(message: TMessage): void {
		if (this.#ctx.isStreaming()) {
			this.#pendingMessages.push(message);
		} else {
			this.#ctx.agent.appendMessage(message);
			this.#ctx.sessionManager.appendMessage(message);
		}
	}

	/** Cancel every in-flight execution. */
	abort(): void {
		for (const abortController of this.#abortControllers) {
			abortController.abort();
		}
	}

	/** Drain the buffered messages into agent state and the session log. */
	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;

		for (const message of this.#pendingMessages) {
			this.#ctx.agent.appendMessage(message);
			this.#ctx.sessionManager.appendMessage(message);
		}
		this.#pendingMessages = [];
	}

	/**
	 * Wait for currently-tracked executions to settle, up to `timeoutMs`. Returns
	 * `true` if every execution settled inside the budget, `false` otherwise. The
	 * caller decides what to do next — typically {@link abort} then a second
	 * shorter wait.
	 */
	async awaitSettlement(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}
}
