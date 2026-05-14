// pi-ai AssistantMessageEvent  ->  Effect 4 Response.StreamPart
//
// Stateless pure-function mapping from the legacy pi-ai event stream onto
// Effect 4's `Response.StreamPart` discriminated union. Used by the bridge
// (see `effect-ai.ts`) to expose pi-ai providers to Effect.gen consumers
// that prefer `LanguageModel.streamText`-style output.
//
// Mapping table:
//   pi-ai                       Effect 4
//   ----------------------------------------------------------------------
//   start                       (omitted — Effect 4 has no stream-open part)
//   text_start                  text-start          { id }
//   text_delta                  text-delta          { id, delta }
//   text_end                    text-end            { id }
//   thinking_start              reasoning-start     { id }
//   thinking_delta              reasoning-delta     { id, delta }
//   thinking_end                reasoning-end       { id }
//   toolcall_start              (omitted — name not yet known at start)
//   toolcall_delta              tool-params-delta   { id, delta }
//   toolcall_end                tool-params-end + tool-call (two parts)
//   done                        finish              { reason, usage }
//   error                       error + finish      { error, ... + reason:"error" }
//
// IDs are derived deterministically from `contentIndex` so start/delta/end
// triples correlate inside one stream. For tool parts at `toolcall_end`,
// the pi-ai `toolCall.id` (assigned by the provider) is used so a consumer
// that re-asks "what tool call was that?" can correlate by id with prior
// tool-params-* parts that used the contentIndex-based id. Both ids are
// emitted as the same string for consistency: `pi-ai/tool/<contentIndex>`.
//
// The reverse direction (Effect 4 -> pi-ai) is stateful (needs a partial
// AssistantMessage accumulator across parts) and lives in the provider
// rewrite — see docs/plans/p4d-http-stream-watchdog.md "Out of scope".

import { Response } from "./effect-ai";
import type { AssistantMessageEvent, Usage as PiAiUsage } from "./types";

const TEXT_BLOCK_PREFIX = "pi-ai/text/";
const REASONING_BLOCK_PREFIX = "pi-ai/reasoning/";
const TOOL_BLOCK_PREFIX = "pi-ai/tool/";

const blockId = (prefix: string, contentIndex: number): string => `${prefix}${contentIndex}`;

/** pi-ai's `done.reason` to Effect 4's `FinishReason`. */
const finishReasonForDone = (reason: "stop" | "length" | "toolUse"): "stop" | "length" | "tool-calls" => {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool-calls";
	}
};

/** Map pi-ai's `Usage` aggregate onto Effect 4's `Response.Usage` shape. */
const buildUsage = (usage: PiAiUsage | undefined): Response.Usage => {
	if (usage === undefined) {
		return new Response.Usage({
			inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: undefined, text: undefined, reasoning: undefined },
		});
	}
	const textOutput = usage.reasoningTokens === undefined ? undefined : usage.output - usage.reasoningTokens;
	return new Response.Usage({
		inputTokens: {
			uncached: usage.input,
			total: usage.input + usage.cacheRead + usage.cacheWrite,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
		},
		outputTokens: {
			total: usage.output,
			text: textOutput,
			reasoning: usage.reasoningTokens,
		},
	});
};

/**
 * Map one pi-ai `AssistantMessageEvent` onto zero or more Effect 4
 * `Response.StreamPart`s. Returns an empty array when the event has no
 * Effect 4 equivalent (e.g. `start`, `toolcall_start`). The output order
 * preserves the emission order the Effect consumer should see.
 *
 * The function is intentionally stateless — `id`s are derived from
 * `contentIndex` so a delta carries the same id as its corresponding
 * start/end, without needing an accumulator across calls.
 */
export const toResponseStreamParts = (event: AssistantMessageEvent): ReadonlyArray<Response.AnyPart> => {
	switch (event.type) {
		case "start":
			// No Effect 4 stream-open marker — the Stream starting IS the marker.
			return [];

		case "text_start":
			return [Response.makePart("text-start", { id: blockId(TEXT_BLOCK_PREFIX, event.contentIndex) })];

		case "text_delta":
			return [
				Response.makePart("text-delta", {
					id: blockId(TEXT_BLOCK_PREFIX, event.contentIndex),
					delta: event.delta,
				}),
			];

		case "text_end":
			return [Response.makePart("text-end", { id: blockId(TEXT_BLOCK_PREFIX, event.contentIndex) })];

		case "thinking_start":
			return [Response.makePart("reasoning-start", { id: blockId(REASONING_BLOCK_PREFIX, event.contentIndex) })];

		case "thinking_delta":
			return [
				Response.makePart("reasoning-delta", {
					id: blockId(REASONING_BLOCK_PREFIX, event.contentIndex),
					delta: event.delta,
				}),
			];

		case "thinking_end":
			return [Response.makePart("reasoning-end", { id: blockId(REASONING_BLOCK_PREFIX, event.contentIndex) })];

		case "toolcall_start":
			// pi-ai emits this before the tool name is known on the wire; Effect 4's
			// tool-params-start requires `name`, so we omit the start marker and let
			// the consumer infer block-open from the first tool-params-delta with a
			// new id. Tool name + final params arrive together at toolcall_end.
			return [];

		case "toolcall_delta":
			return [
				Response.makePart("tool-params-delta", {
					id: blockId(TOOL_BLOCK_PREFIX, event.contentIndex),
					delta: event.delta,
				}),
			];

		case "toolcall_end": {
			const toolId = blockId(TOOL_BLOCK_PREFIX, event.contentIndex);
			return [
				Response.makePart("tool-params-end", { id: toolId }),
				Response.makePart("tool-call", {
					id: toolId,
					name: event.toolCall.name,
					params: event.toolCall.arguments,
					providerExecuted: false,
				}),
			];
		}

		case "done":
			return [
				Response.makePart("finish", {
					reason: finishReasonForDone(event.reason),
					usage: buildUsage(event.message.usage),
					response: undefined,
				}),
			];

		case "error":
			return [
				Response.makePart("error", { error: event.error }),
				Response.makePart("finish", {
					reason: "error",
					usage: buildUsage(event.error.usage),
					response: undefined,
				}),
			];
	}
};
