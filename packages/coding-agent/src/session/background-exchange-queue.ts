import type { CustomMessage } from "./messages";

/**
 * Dependencies the {@link BackgroundExchangeQueue} needs from its owning
 * session.
 */
export interface BackgroundExchangeQueueContext {
	isStreaming(): boolean;
	emitMessageEvent(event: { type: "message_start" | "message_end"; message: CustomMessage }): void;
}

/**
 * Owns the per-session queue of "background-channel IRC exchanges" that
 * arrived while the recipient was streaming. Each batch (incoming message ±
 * auto-reply) is held until the session goes idle, then emitted via
 * {@link BackgroundExchangeQueueContext.emitMessageEvent} so listeners append
 * to history and persist.
 *
 * Extracted from `AgentSession` to give the cluster a deletion-test seam.
 * Cluster shape: a `setTimeout`-based polling flush that re-checks
 * `isStreaming()` every 50 ms until idle. Disabling the queue is a one-line
 * change.
 */
export class BackgroundExchangeQueue {
	#ctx: BackgroundExchangeQueueContext;
	#pending: CustomMessage[][] = [];
	#scheduled = false;

	constructor(ctx: BackgroundExchangeQueueContext) {
		this.#ctx = ctx;
	}

	/**
	 * Queue a batch (incoming message and optional auto-reply) for injection.
	 * Flushes immediately if the session is idle; otherwise schedules a
	 * deferred flush.
	 */
	queue(messages: CustomMessage[]): void {
		this.#pending.push(messages);
		if (!this.#ctx.isStreaming()) {
			this.flushPending();
			return;
		}
		this.#scheduleFlush();
	}

	/** Drain the queue immediately. Called before the next prompt. */
	flushPending(): void {
		if (this.#pending.length === 0) return;
		const batches = this.#pending;
		this.#pending = [];
		for (const batch of batches) {
			for (const msg of batch) {
				// emit on message_end appends to agent state and dispatches to
				// all session listeners, which in turn handle TUI rendering and
				// sessionManager persistence.
				this.#ctx.emitMessageEvent({ type: "message_start", message: msg });
				this.#ctx.emitMessageEvent({ type: "message_end", message: msg });
			}
		}
	}

	#scheduleFlush(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		const attempt = (): void => {
			if (this.#pending.length === 0) {
				this.#scheduled = false;
				return;
			}
			if (this.#ctx.isStreaming()) {
				setTimeout(attempt, 50);
				return;
			}
			this.#scheduled = false;
			this.flushPending();
		};
		setTimeout(attempt, 0);
	}
}
