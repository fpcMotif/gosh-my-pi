import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import atomDescription from "../prompts/tools/atom.md" with { type: "text" };
import hashlineDescription from "../prompts/tools/hashline.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import { vimSchema } from "../tools/vim";
import type { VimToolDetails } from "../vim/types";
import type { EditModeDefinition, EditTool, EditToolResultDetails, TInput } from "./index";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import { type AtomParams, atomEditParamsSchema, executeAtomSingle } from "./modes/atom";
import atomGrammar from "./modes/atom.lark" with { type: "text" };
import {
	executeHashlineSingle,
	type HashlineParams,
	type HashlineToolEdit,
	hashlineEditParamsSchema,
} from "./modes/hashline";
import { executePatchSingle, type PatchEditEntry, type PatchParams, patchEditSchema } from "./modes/patch";
import { executeReplaceSingle, type ReplaceEditEntry, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { executeApplyPatchPerFile, executeSinglePathEntries } from "./mode-runner";
import type { LspBatchRequest } from "./renderer";

type ExtendedDefinition = EditModeDefinition & { customFormat?: { syntax: "lark"; definition: string } };
type DefinitionMap = Record<string, ExtendedDefinition>;

function definePatchMode(): EditModeDefinition {
	return {
		description: () => prompt.render(patchDescription),
		parameters: patchEditSchema,
		execute: (tool, params, signal, batchRequest, onUpdate) => {
			const { edits, path } = params as PatchParams;
			const runs = (edits as PatchEditEntry[]).map(
				entry => (br: LspBatchRequest | undefined) =>
					executePatchSingle({
						session: tool.session,
						path,
						params: entry,
						signal,
						batchRequest: br,
						allowFuzzy: tool.allowFuzzy,
						fuzzyThreshold: tool.fuzzyThreshold,
						writethrough: tool.writethrough,
						beginDeferredDiagnosticsForPath: p => tool.beginDeferredDiagnosticsForPath(p),
					}),
			);
			return executeSinglePathEntries(path, runs, batchRequest, onUpdate) as Promise<
				AgentToolResult<EditToolResultDetails, TInput>
			>;
		},
	};
}

function defineApplyPatchMode(): ExtendedDefinition {
	return {
		description: () => prompt.render(applyPatchDescription),
		parameters: applyPatchSchema,
		customFormat: { syntax: "lark", definition: applyPatchGrammar },
		execute: (tool, params, signal, batchRequest, onUpdate) => {
			const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
			const perFile = entries.map(entry => {
				const { path, ...patchParams } = entry;
				return {
					path,
					run: (br: LspBatchRequest | undefined) =>
						executePatchSingle({
							session: tool.session,
							path,
							params: patchParams,
							signal,
							batchRequest: br,
							allowFuzzy: tool.allowFuzzy,
							fuzzyThreshold: tool.fuzzyThreshold,
							writethrough: tool.writethrough,
							beginDeferredDiagnosticsForPath: p => tool.beginDeferredDiagnosticsForPath(p),
						}),
				};
			});
			return executeApplyPatchPerFile(perFile, batchRequest, onUpdate) as Promise<
				AgentToolResult<EditToolResultDetails, TInput>
			>;
		},
	};
}

function defineHashlineMode(): EditModeDefinition {
	return {
		description: () => prompt.render(hashlineDescription),
		parameters: hashlineEditParamsSchema,
		execute: (tool, params, signal, batchRequest, _onUpdate) => {
			const { edits, path } = params as HashlineParams;
			return executeHashlineSingle({
				session: tool.session,
				path,
				edits: edits as HashlineToolEdit[],
				signal,
				batchRequest,
				writethrough: tool.writethrough,
				beginDeferredDiagnosticsForPath: p => tool.beginDeferredDiagnosticsForPath(p),
			}) as Promise<AgentToolResult<EditToolResultDetails, TInput>>;
		},
	};
}

function defineAtomMode(): ExtendedDefinition {
	return {
		description: () => prompt.render(atomDescription),
		parameters: atomEditParamsSchema,
		customFormat: { syntax: "lark", definition: atomGrammar },
		execute: (tool, params, signal, batchRequest, _onUpdate) => {
			const { input, path } = params as AtomParams & { path?: string };
			return executeAtomSingle({
				session: tool.session,
				input,
				path,
				signal,
				batchRequest,
				writethrough: tool.writethrough,
				beginDeferredDiagnosticsForPath: p => tool.beginDeferredDiagnosticsForPath(p),
			}) as Promise<AgentToolResult<EditToolResultDetails, TInput>>;
		},
	};
}

function defineReplaceMode(): EditModeDefinition {
	return {
		description: () => prompt.render(replaceDescription),
		parameters: replaceEditSchema,
		execute: (tool, params, signal, batchRequest, onUpdate) => {
			const { edits, path } = params as ReplaceParams;
			const runs = (edits as ReplaceEditEntry[]).map(
				entry => (br: LspBatchRequest | undefined) =>
					executeReplaceSingle({
						session: tool.session,
						path,
						params: entry,
						signal,
						batchRequest: br,
						allowFuzzy: tool.allowFuzzy,
						fuzzyThreshold: tool.fuzzyThreshold,
						writethrough: tool.writethrough,
						beginDeferredDiagnosticsForPath: p => tool.beginDeferredDiagnosticsForPath(p),
					}),
			);
			return executeSinglePathEntries(path, runs, batchRequest, onUpdate) as Promise<
				AgentToolResult<EditToolResultDetails, TInput>
			>;
		},
	};
}

function defineVimMode(tool: EditTool): EditModeDefinition {
	return {
		description: () => tool.vimTool.description,
		parameters: vimSchema,
		execute: async (innerTool, params, signal, _batchRequest, onUpdate) => {
			const handleUpdate = onUpdate
				? (partialResult: AgentToolResult<VimToolDetails>) => {
						onUpdate(partialResult as AgentToolResult<EditToolResultDetails, TInput>);
					}
				: undefined;
			return (await innerTool.vimTool.execute(
				"edit",
				params as Parameters<EditTool["vimTool"]["execute"]>[1],
				signal,
				handleUpdate,
			)) as AgentToolResult<EditToolResultDetails, TInput>;
		},
	};
}

/**
 * Build the mode definitions map keyed by mode name.
 *
 * The `vim` mode binds to `tool.vimTool.description`, so we need the tool
 * to construct that closure.
 */
export function buildEditModeDefinitions(tool: EditTool): DefinitionMap {
	return {
		patch: definePatchMode(),
		apply_patch: defineApplyPatchMode(),
		hashline: defineHashlineMode(),
		atom: defineAtomMode(),
		replace: defineReplaceMode(),
		vim: defineVimMode(tool),
	};
}
