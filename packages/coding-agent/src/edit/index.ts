import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
	writethroughNoop,
} from "../lsp";
import type { ToolSession } from "../tools";
import { VimTool } from "../tools/vim";
import type { vimSchema } from "../tools/vim";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import type { VimToolDetails } from "../vim/types";
import type { ApplyPatchParams, applyPatchSchema } from "./modes/apply-patch";
import type { AtomParams, atomEditParamsSchema } from "./modes/atom";
import type { HashlineParams, hashlineEditParamsSchema } from "./modes/hashline";
import type { PatchParams, patchEditSchema } from "./modes/patch";
import type { ReplaceParams, replaceEditSchema } from "./modes/replace";
import { buildEditModeDefinitions } from "./mode-definitions";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "./renderer";
import { getLspBatchRequest } from "./renderer";

export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./line-hash";
export * from "./modes/apply-patch";
export * from "./modes/atom";
export * from "./modes/hashline";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./streaming";

export type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof atomEditParamsSchema
	| typeof vimSchema
	| typeof applyPatchSchema;

type VimParams = Static<typeof vimSchema>;
export type EditParams = ReplaceParams | PatchParams | HashlineParams | AtomParams | VimParams | ApplyPatchParams;
export type EditToolResultDetails = EditToolDetails | VimToolDetails;

export type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolResultDetails, TInput>>;
};

export type { EditToolDetails, EditToolPerFileResult, LspBatchRequest };

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (rawEditMode === "" || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	return enableLsp ? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics }) : writethroughNoop;
}

export class EditTool implements AgentTool<TInput> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #vimTool: VimTool;
	readonly #pendingDeferredFetches = new Map<string, AbortController>();

	constructor(readonly session: ToolSession) {
		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		this.#writethrough = createEditWritethrough(session);
		this.#vimTool = new VimTool(session);
	}

	get allowFuzzy(): boolean {
		return this.#allowFuzzy;
	}

	get fuzzyThreshold(): number {
		return this.#fuzzyThreshold;
	}

	get writethrough(): WritethroughCallback {
		return this.#writethrough;
	}

	get vimTool(): VimTool {
		return this.#vimTool;
	}

	beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		return this.#beginDeferredDiagnosticsForPath(path);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	/**
	 * When in `apply_patch` mode, expose the Codex Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		return this.#getModeDefinition().customFormat;
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolResultDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolResultDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition & { customFormat?: { syntax: "lark"; definition: string } } {
		return buildEditModeDefinitions(this)[this.mode];
	}

	#beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		const existingDeferred = this.#pendingDeferredFetches.get(path);
		if (existingDeferred) {
			existingDeferred.abort();
			this.#pendingDeferredFetches.delete(path);
		}

		const deferredController = new AbortController();
		return {
			onDeferredDiagnostics: (lateDiagnostics: FileDiagnosticsResult) => {
				this.#pendingDeferredFetches.delete(path);
				this.#injectLateDiagnostics(path, lateDiagnostics);
			},
			signal: deferredController.signal,
			finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
				if (diagnostics) {
					deferredController.abort();
				} else {
					this.#pendingDeferredFetches.set(path, deferredController);
				}
			},
		};
	}

	#injectLateDiagnostics(path: string, diagnostics: FileDiagnosticsResult): void {
		const summary = diagnostics.summary ?? "";
		const lines = diagnostics.messages ?? [];
		const body = [`Late LSP diagnostics for ${path} (arrived after the edit tool returned):`, summary, ...lines]
			.filter(Boolean)
			.join("\n");

		this.session.queueDeferredMessage?.({
			role: "custom",
			customType: "lsp-late-diagnostic",
			content: body,
			display: false,
			timestamp: Date.now(),
		});
	}
}
