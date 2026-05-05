import type { AssistantMessage, AssistantMessageEvent } from "../../types";
import { EventStream } from "./base";

type DeltaEvent = Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" | "toolcall_delta" }>;

function isDeltaEvent(event: AssistantMessageEvent): event is DeltaEvent {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
}

function isFinalEvent(event: AssistantMessageEvent): boolean {
	return event.type === "done" || event.type === "error";
}

function extractFinalResult(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	throw new Error("Unexpected event type for final result");
}

/**
 * Throttled event stream for assistant messages.
 *
 * Buffers delta events and emits them in batches to reduce UI reactivity overhead.
 * Non-delta events (start, end, error, usage, metadata) are delivered immediately.
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	// Throttling state
	#deltaBuffer: DeltaEvent[] = [];
	#flushTimer?: ReturnType<typeof setTimeout>;
	#lastFlushTime = 0;
	readonly #throttleMs = 50; // 20 updates/sec

	constructor() {
		super(isFinalEvent, extractFinalResult);
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;

		// Check for completion first
		if (isFinalEvent(event)) {
			this.#flushDeltas(); // Flush any pending deltas before completing
			this.done = true;
			this.resolveFinalResult(extractFinalResult(event));
		}

		// Delta events get batched and throttled
		if (isDeltaEvent(event)) {
			this.#deltaBuffer.push(event);
			this.#scheduleFlush();
			return;
		}

		// Non-delta events flush pending deltas immediately, then emit
		this.#flushDeltas();
		this.deliver(event);
	}

	override end(result?: AssistantMessage): void {
		this.#flushDeltas();
		super.end(result);
	}

	override error(err: unknown): void {
		this.#flushDeltas();
		super.error(err);
	}

	#scheduleFlush(): void {
		if (this.#flushTimer !== undefined) return;

		const now = Date.now();
		const timeSinceLastFlush = now - this.#lastFlushTime;
		const delay = Math.max(0, this.#throttleMs - timeSinceLastFlush);

		if (delay === 0) {
			this.#flushDeltas();
		} else {
			this.#flushTimer = setTimeout(() => {
				this.#flushTimer = undefined;
				this.#flushDeltas();
			}, delay);
		}
	}

	#flushDeltas(): void {
		if (this.#deltaBuffer.length === 0) return;

		const deltas = this.#deltaBuffer;
		this.#deltaBuffer = [];
		this.#lastFlushTime = Date.now();

		if (this.#flushTimer !== undefined) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}

		for (const delta of deltas) {
			this.deliver(delta);
		}
	}
}
