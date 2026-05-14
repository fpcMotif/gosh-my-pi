// pi-ai Tool[]  ->  Effect 4 Toolkit
//
// Slice 4 — builds a `Toolkit` of Effect 4 `Tool`s from pi-ai's `Tool<TSchema>`
// definitions so call-site agent loops can pass `toolkit:
// toolkitFromPiAiTools(context.tools)` to `LanguageModel.streamText`.
//
// Schema strategy: pi-ai tools carry their parameter shape as TypeBox
// `TSchema` (which is itself a JSON Schema document). Effect 4 expects
// `Schema.Top` from `effect/Schema`. A full TypeBox -> effect/Schema
// converter is non-trivial because Effect 4's schema language is richer
// (refinements, transforms, branded types) and pi-ai tools use TypeBox in
// a closed subset.
//
// For now this bridge uses `Schema.Unknown` for every tool's parameters.
// The LLM still sees the tool name + description; tool-call params arrive
// at the provider as `Record<string, unknown>` and pi-ai's existing
// agent loop already accepts that shape on the receive side. A future
// sub-slice can add a proper TypeBox -> Schema converter to recover the
// strict-mode validation pi-ai supports today.

import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import type { Tool as PiAiTool } from "./types";

type RuntimePiAiTool = Tool.ProviderDefined<
	"pi-ai.tool",
	string,
	{
		readonly args: typeof Schema.Void;
		readonly parameters: typeof Schema.Unknown;
		readonly success: typeof Schema.Void;
		readonly failure: typeof Schema.Never;
		readonly failureMode: "error";
	},
	false
>;

type RuntimePiAiTools = { readonly [name: string]: RuntimePiAiTool };

const makeRuntimeTool = (tool: PiAiTool): RuntimePiAiTool =>
	Object.assign(
		Tool.providerDefined({
			id: "pi-ai.tool",
			customName: tool.name,
			providerName: tool.name,
			parameters: Schema.Unknown,
		})(undefined),
		{ description: tool.description },
	);

/**
 * Convert a pi-ai `Tool[]` into an Effect 4 `Toolkit` ready to pass to
 * `LanguageModel.streamText({ prompt, toolkit })`. Returns `undefined`
 * when the input is empty / absent so call sites can branch the streamText
 * options shape (toolkit omitted vs. present).
 *
 * The toolkit type parameter is widened to `Record<string, Tool.Any>` for
 * a runtime-built input — full `Toolkit<{...}>` strong typing requires
 * the tool list to be a const tuple, which pi-ai's runtime tool array
 * isn't.
 */
export const toolkitFromPiAiTools = (
	tools: ReadonlyArray<PiAiTool> | undefined,
): Toolkit.Toolkit<RuntimePiAiTools> | undefined => {
	if (tools === undefined || tools.length === 0) return undefined;
	const effectTools = tools.map(makeRuntimeTool);
	return Toolkit.make(...effectTools);
};
