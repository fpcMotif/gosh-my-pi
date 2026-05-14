// Effect 4 `Response.AnyPart`  ->  pi-ai AssistantMessageEvent (stateful)
//
// The reverse direction of `effect-ai-stream-adapter.ts`. Where the forward
// mapper is stateless (one pi-ai event -> 0..N Effect parts) the reverse
// direction has to *accumulate* — pi-ai's `partial: AssistantMessage` field
// is the running aggregate of every emitted block, so consumers can render
// the stream incrementally. Effect 4's stream just emits typed deltas with
// correlation ids; the accumulator owns the materialised content.
//
// Used by the in-progress `streamOpenAIResponses` rewrite (next slice) to
// fold `m.streamText({...})` output back into the pi-ai
// `AssistantMessageEventStream` consumers expect. The forward adapter +
// this accumulator together close the bidirectional mapping called for in
// the slice table.
//
// Mapping table (reverse of effect-ai-stream-adapter):
//   Effect 4                   pi-ai
//   ----------------------------------------------------------------------
//   (first part seen)          start                                        [auto-emitted once]
//   text-start                  text_start         { contentIndex, partial }
//   text-delta                  text_delta         { contentIndex, delta, partial }
//   text-end                    text_end           { contentIndex, content, partial }
//   reasoning-start             thinking_start
//   reasoning-delta             thinking_delta
//   reasoning-end               thinking_end
//   tool-params-start           toolcall_start
//   tool-params-delta           toolcall_delta     { contentIndex, delta, partial }
//   tool-params-end             (no event — pi-ai materialises at end below)
//   tool-call                   toolcall_end       { contentIndex, toolCall, partial }
//   finish                      done               { reason, message }
//   error                       error              { reason: "error", error }
//   (other Response parts)      (no event — informational only)

import type { Response } from "./effect-ai";
import type { Api, AssistantMessage, AssistantMessageEvent, Provider, StopReason, ToolCall, Usage } from "./types";

/** Constructor seed — the wire-level identity pi-ai needs on every message. */
export interface ResponseStreamAccumulatorSeed {
	readonly api: Api;
	readonly provider: Provider;
	readonly model: string;
	/** Timestamp used in the initial partial; defaults to `Date.now()`. */
	readonly timestamp?: number;
}

const emptyCost = (): Usage["cost"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

const emptyUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: emptyCost(),
});

const finishReasonToStopReason = (reason: string): StopReason => {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "tool-calls":
			return "toolUse";
		case "error":
		case "content-filter":
		case "pause":
		case "other":
		case "unknown":
			return "error";
		default:
			return "error";
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const usageFromEffect = (eff: Response.Usage): Usage => {
	const input = eff.inputTokens.uncached ?? 0;
	const output = eff.outputTokens.total ?? 0;
	const cacheRead = eff.inputTokens.cacheRead ?? 0;
	const cacheWrite = eff.inputTokens.cacheWrite ?? 0;
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: emptyCost(),
	};
	if (eff.outputTokens.reasoning !== undefined) {
		usage.reasoningTokens = eff.outputTokens.reasoning;
	}
	return usage;
};

/**
 * Stateful accumulator for the reverse mapping. Construct one per stream;
 * `feed(part)` for each Effect 4 part in arrival order. Returns the pi-ai
 * events that part triggers; `partial` always reflects the running aggregate
 * the next event's consumer should see.
 *
 * The accumulator emits exactly one `start` event automatically on the first
 * `feed()` call so consumers that expect the pi-ai lifecycle marker see it.
 */
export class ResponseStreamAccumulator {
	#partial: AssistantMessage;
	/** Effect-4 id -> pi-ai contentIndex per content kind. */
	#textIndexById = new Map<string, number>();
	#reasoningIndexById = new Map<string, number>();
	#toolIndexById = new Map<string, number>();
	/** Accumulated JSON fragments per tool id (delta order). */
	#toolParamsById = new Map<string, string>();
	#emittedStart = false;

	constructor(seed: ResponseStreamAccumulatorSeed) {
		this.#partial = {
			role: "assistant",
			content: [],
			api: seed.api,
			provider: seed.provider,
			model: seed.model,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: seed.timestamp ?? Date.now(),
		};
	}

	get partial(): AssistantMessage {
		return this.#partial;
	}

	#snapshot(): AssistantMessage {
		// Shallow clone — pi-ai consumers treat `partial` as a read-only view.
		// The deep content[] is shared by reference; subsequent feed() calls
		// will mutate that array in place, so consumers that want the snapshot
		// AT this event must materialise it themselves (matches the existing
		// pi-ai provider contract).
		return this.#partial;
	}

	#ensureStart(events: AssistantMessageEvent[]): void {
		if (this.#emittedStart) return;
		this.#emittedStart = true;
		events.push({ type: "start", partial: this.#snapshot() });
	}

	#openTextBlock(id: string): number {
		const existing = this.#textIndexById.get(id);
		if (existing !== undefined) return existing;
		const contentIndex = this.#partial.content.length;
		this.#partial.content.push({ type: "text", text: "" });
		this.#textIndexById.set(id, contentIndex);
		return contentIndex;
	}

	#openReasoningBlock(id: string): number {
		const existing = this.#reasoningIndexById.get(id);
		if (existing !== undefined) return existing;
		const contentIndex = this.#partial.content.length;
		this.#partial.content.push({ type: "thinking", thinking: "" });
		this.#reasoningIndexById.set(id, contentIndex);
		return contentIndex;
	}

	#openToolBlock(id: string, name: string): number {
		const existing = this.#toolIndexById.get(id);
		if (existing !== undefined) return existing;
		const contentIndex = this.#partial.content.length;
		this.#partial.content.push({ type: "toolCall", id, name, arguments: {} });
		this.#toolIndexById.set(id, contentIndex);
		this.#toolParamsById.set(id, "");
		return contentIndex;
	}

	feed(part: Response.AnyPart): AssistantMessageEvent[] {
		const events: AssistantMessageEvent[] = [];
		this.#ensureStart(events);

		switch (part.type) {
			case "text-start": {
				const contentIndex = this.#openTextBlock(part.id);
				events.push({ type: "text_start", contentIndex, partial: this.#snapshot() });
				return events;
			}

			case "text-delta": {
				const contentIndex = this.#openTextBlock(part.id);
				const block = this.#partial.content[contentIndex];
				if (block !== undefined && block.type === "text") {
					block.text += part.delta;
				}
				events.push({
					type: "text_delta",
					contentIndex,
					delta: part.delta,
					partial: this.#snapshot(),
				});
				return events;
			}

			case "text-end": {
				const contentIndex = this.#textIndexById.get(part.id);
				if (contentIndex === undefined) return events;
				const block = this.#partial.content[contentIndex];
				const content = block !== undefined && block.type === "text" ? block.text : "";
				events.push({ type: "text_end", contentIndex, content, partial: this.#snapshot() });
				return events;
			}

			case "reasoning-start": {
				const contentIndex = this.#openReasoningBlock(part.id);
				events.push({ type: "thinking_start", contentIndex, partial: this.#snapshot() });
				return events;
			}

			case "reasoning-delta": {
				const contentIndex = this.#openReasoningBlock(part.id);
				const block = this.#partial.content[contentIndex];
				if (block !== undefined && block.type === "thinking") {
					block.thinking += part.delta;
				}
				events.push({
					type: "thinking_delta",
					contentIndex,
					delta: part.delta,
					partial: this.#snapshot(),
				});
				return events;
			}

			case "reasoning-end": {
				const contentIndex = this.#reasoningIndexById.get(part.id);
				if (contentIndex === undefined) return events;
				const block = this.#partial.content[contentIndex];
				const content = block !== undefined && block.type === "thinking" ? block.thinking : "";
				events.push({ type: "thinking_end", contentIndex, content, partial: this.#snapshot() });
				return events;
			}

			case "tool-params-start": {
				const contentIndex = this.#openToolBlock(part.id, part.name);
				events.push({ type: "toolcall_start", contentIndex, partial: this.#snapshot() });
				return events;
			}

			case "tool-params-delta": {
				const contentIndex = this.#toolIndexById.get(part.id);
				if (contentIndex === undefined) return events;
				const accumulated = (this.#toolParamsById.get(part.id) ?? "") + part.delta;
				this.#toolParamsById.set(part.id, accumulated);
				events.push({
					type: "toolcall_delta",
					contentIndex,
					delta: part.delta,
					partial: this.#snapshot(),
				});
				return events;
			}

			case "tool-params-end": {
				// pi-ai materialises the toolcall_end event when the `tool-call` part
				// arrives (with the typed `params` object). The end marker on its own
				// is informational only.
				return events;
			}

			case "tool-call": {
				const contentIndex = this.#openToolBlock(part.id, part.name);
				const block = this.#partial.content[contentIndex];
				if (block !== undefined && block.type === "toolCall") {
					const params: unknown = part.params;
					block.arguments = isRecord(params) ? params : {};
					const toolCall: ToolCall = {
						type: "toolCall",
						id: block.id,
						name: block.name,
						arguments: block.arguments,
					};
					events.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.#snapshot() });
				}
				return events;
			}

			case "finish": {
				this.#partial.usage = usageFromEffect(part.usage);
				const stopReason = finishReasonToStopReason(part.reason);
				this.#partial.stopReason = stopReason;
				if (stopReason === "error") {
					events.push({ type: "error", reason: "error", error: this.#snapshot() });
				} else if (stopReason === "aborted") {
					events.push({ type: "error", reason: "aborted", error: this.#snapshot() });
				} else {
					events.push({ type: "done", reason: stopReason, message: this.#snapshot() });
				}
				return events;
			}

			case "error": {
				this.#partial.stopReason = "error";
				const message = typeof part.error === "string" ? part.error : undefined;
				if (message !== undefined) {
					this.#partial.errorMessage = message;
				}
				events.push({ type: "error", reason: "error", error: this.#snapshot() });
				return events;
			}

			default:
				// Informational parts (response-metadata, file, document-source,
				// url-source, tool-approval-request, tool-result, text, reasoning)
				// have no pi-ai equivalent — silently dropped.
				return events;
		}
	}
}
