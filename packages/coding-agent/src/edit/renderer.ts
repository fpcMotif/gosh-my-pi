/**
 * Edit tool renderer and LSP batching helpers.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { FileDiagnosticsResult } from "../lsp";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import {
	formatDiagnostics,
	formatStatusIcon,
	formatTitle,
	getLspBatchRequest,
	type LspBatchRequest,
} from "../tools/render-utils";
import { type VimRenderArgs, vimToolRenderer } from "../tools/vim";
import { Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import type { EditMode } from "../utils/edit-mode";
import type { VimToolDetails } from "../vim/types";
import type { DiffError, DiffResult } from "./diff";
import type { Operation } from "./modes/patch";
import {
	CALL_TEXT_PREVIEW_WIDTH,
	countEditFiles,
	countLines,
	type EditRenderArgs,
	type EditRenderEntry,
	filePathFromEditEntry,
	formatEditPathDisplay,
	formatMetadataLine,
	getApplyPatchRenderSummary,
	getAtomRenderSummary,
	getCallPreview,
	getOperationTitle,
	getPartialJsonEditPath,
	isNonEmpty,
	renderDiffSection,
	sanitizeRendererText,
	wrapEditRendererLine,
} from "./renderer-helpers";
import type { PerFileDiffPreview } from "./streaming";

// ═══════════════════════════════════════════════════════════════════════════
// LSP Batching
// ═══════════════════════════════════════════════════════════════════════════

export { getLspBatchRequest, type LspBatchRequest };

// ═══════════════════════════════════════════════════════════════════════════
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** TUI-friendly error text. When present, rendered to the user instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
}

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

function isVimRenderArgs(args: EditRenderArgs | VimRenderArgs): args is VimRenderArgs {
	return (
		typeof args === "object" &&
		args !== null &&
		typeof (args as { file?: unknown }).file === "string" &&
		!("path" in args) &&
		!("file_path" in args) &&
		!("edits" in args)
	);
}

function isVimToolDetails(details: unknown): details is VimToolDetails {
	if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details)) {
		return false;
	}
	const cursor = (details as { cursor?: unknown }).cursor;
	const viewportLines = (details as { viewportLines?: unknown }).viewportLines;
	return (
		typeof (details as { file?: unknown }).file === "string" &&
		typeof cursor === "object" &&
		cursor !== null &&
		Array.isArray(viewportLines)
	);
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Edit mode resolved by the caller; lets the renderer dispatch without shape-sniffing */
	editMode?: EditMode;
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: DiffResult | DiffError;
	/** Multi-file streaming diff preview (edits spanning several files) */
	perFileDiffPreview?: PerFileDiffPreview[];
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

function formatEditDescription(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): { language: string; description: string } {
	const language = getLanguageFromPath(rawPath) ?? "text";
	const icon = uiTheme.fg("muted", uiTheme.getLangIcon(language));
	return {
		language,
		description: `${icon} ${formatEditPathDisplay(rawPath, uiTheme, options)}`,
	};
}

interface RenderCallContext {
	args: EditRenderArgs;
	uiTheme: Theme;
	options: RenderResultOptions & { renderContext?: EditRenderContext };
}

interface ResolvedCallContext {
	rawPath: string;
	rename: string | undefined;
	op: Operation | undefined;
	atomFileCount: number;
	applyPatchFileCount: number;
	applyPatchError: string | undefined;
	editsFileCount: number;
}

function firstNonEmpty(...values: (string | undefined)[]): string {
	for (const value of values) {
		if (value !== undefined && value !== "") return value;
	}
	return "";
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

function getFirstEdit(args: EditRenderArgs): EditRenderEntry | undefined {
	if (!Array.isArray(args.edits) || args.edits.length === 0) return undefined;
	return args.edits[0];
}

function resolveCallContext(ctx: RenderCallContext): ResolvedCallContext {
	const { args, options } = ctx;
	const renderContext = options.renderContext;
	const atomSummary = getAtomRenderSummary(args, renderContext?.editMode);
	const applyPatchSummary = getApplyPatchRenderSummary(args, options.isPartial, renderContext?.editMode);
	const firstApplyPatchEntry = applyPatchSummary?.entries[0];
	const firstAtomEntry = atomSummary?.entries[0];
	const firstEdit = getFirstEdit(args);
	const rawPath = firstNonEmpty(
		args.file_path,
		args.path,
		filePathFromEditEntry(firstEdit?.path),
		getPartialJsonEditPath(args),
		firstAtomEntry?.path,
		firstApplyPatchEntry?.path,
	);
	const rename = firstDefined(args.rename, firstEdit?.rename, firstEdit?.move, firstApplyPatchEntry?.rename);
	const op = firstDefined(args.op, firstEdit?.op, firstApplyPatchEntry?.op);
	const editsFileCount = Array.isArray(args.edits) ? countEditFiles(args.edits) : 0;
	return {
		rawPath,
		rename,
		op,
		atomFileCount: atomSummary?.entries.length ?? 0,
		applyPatchFileCount: applyPatchSummary?.entries.length ?? 0,
		applyPatchError: applyPatchSummary?.error,
		editsFileCount,
	};
}

function buildRenderCallText(ctx: RenderCallContext, resolved: ResolvedCallContext): string {
	const { args, options, uiTheme } = ctx;
	const { rawPath, rename, op, atomFileCount, applyPatchFileCount, applyPatchError, editsFileCount } = resolved;
	const { description } = formatEditDescription(rawPath, uiTheme, { rename });
	const spinner =
		options?.spinnerFrame === undefined ? "" : formatStatusIcon("running", uiTheme, options.spinnerFrame);
	let text = `${formatTitle(getOperationTitle(op), uiTheme)} ${spinner === "" ? "" : `${spinner} `}${description}`;

	let fileCount = atomFileCount > 0 ? atomFileCount : applyPatchFileCount;
	if (editsFileCount > 0) {
		fileCount = editsFileCount;
	}
	if (fileCount > 1) {
		text += uiTheme.fg("dim", ` (+${fileCount - 1} more)`);
	}
	text += getCallPreview(args, rawPath, uiTheme, options.renderContext);
	if (isNonEmpty(applyPatchError)) {
		text += `\n\n${uiTheme.fg(
			"error",
			truncateToWidth(sanitizeRendererText(applyPatchError, rawPath), CALL_TEXT_PREVIEW_WIDTH),
		)}`;
	}
	return text;
}

export const editToolRenderer = {
	mergeCallAndResult: true,

	renderCall(
		args: EditRenderArgs | VimRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
	): Component {
		const renderContext = options.renderContext;
		// Dispatch on the explicit editMode when available; fall back to the
		// shape probe for legacy call sites that don't thread renderContext.
		if (renderContext?.editMode === "vim" || isVimRenderArgs(args)) {
			return vimToolRenderer.renderCall(args as VimRenderArgs, options, uiTheme);
		}

		const editArgs = args as EditRenderArgs;
		const resolved = resolveCallContext({ args: editArgs, options, uiTheme });
		const text = buildRenderCallText({ args: editArgs, options, uiTheme }, resolved);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		if (options.renderContext?.editMode === "vim" || isVimToolDetails(result.details)) {
			return vimToolRenderer.renderResult(
				result as { content: Array<{ type: string; text?: string }>; details?: VimToolDetails; isError?: boolean },
				options,
				uiTheme,
			);
		}

		const perFileResults = result.details?.perFileResults;
		const totalFiles = args?.edits ? countEditFiles(args.edits) : 0;
		if (perFileResults && (perFileResults.length > 1 || totalFiles > 1)) {
			return renderMultiFileResult(perFileResults, totalFiles, options, uiTheme);
		}
		return renderSingleFileResult(result, options, uiTheme, args);
	},
};

interface SingleFileRenderInputs {
	rawPath: string;
	op: Operation | undefined;
	rename: string | undefined;
	language: string;
	metadataLine: string;
	isError: boolean;
	errorText: string;
}

function resolveErrorText(
	isError: boolean,
	details: EditToolDetails | EditToolPerFileResult | undefined,
	result: { content: Array<{ type: string; text?: string }> },
): string {
	if (!isError) return "";
	const displayErrorText = details && "displayErrorText" in details ? details.displayErrorText : undefined;
	if (isNonEmpty(displayErrorText)) return displayErrorText;
	const detailsErrorText = details && "errorText" in details ? details.errorText : undefined;
	if (isNonEmpty(detailsErrorText)) return detailsErrorText;
	return result.content?.find(c => c.type === "text")?.text ?? "";
}

function resolveSingleFilePath(
	args: EditRenderArgs | undefined,
	firstEdit: EditRenderEntry | undefined,
	details: EditToolDetails | EditToolPerFileResult | undefined,
	atomFirstEntry: { path: string } | undefined,
): string {
	const detailsPath = details && "path" in details && details.path !== "" ? details.path : undefined;
	return firstNonEmpty(
		args?.file_path,
		args?.path,
		filePathFromEditEntry(firstEdit?.path),
		detailsPath,
		atomFirstEntry?.path,
	);
}

function resolveSingleFileInputs(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args?: EditRenderArgs,
): SingleFileRenderInputs {
	const details = result.details;
	const detailsIsError = details !== undefined && "isError" in details && details.isError === true;
	const isError = result.isError === true || detailsIsError;
	const firstEdit = args?.edits?.[0];
	const atomSummary = getAtomRenderSummary(args ?? {}, options.renderContext?.editMode);
	const firstAtomEntry = atomSummary?.entries[0];
	const rawPath = resolveSingleFilePath(args, firstEdit, details, firstAtomEntry);
	const op = firstDefined(args?.op, firstEdit?.op, details?.op);
	const rename = firstDefined(args?.rename, firstEdit?.rename, firstEdit?.move, details?.move);
	const { language } = formatEditDescription(rawPath, uiTheme, { rename });

	const editTextSource = firstDefined(args?.newText, args?.oldText, args?.diff, args?.patch);
	const metadataLineCount = isNonEmpty(editTextSource) ? countLines(editTextSource) : null;
	const metadataLine = op === "delete" ? "" : `\n${formatMetadataLine(metadataLineCount, language, uiTheme)}`;

	const errorText = resolveErrorText(isError, details, result);

	return { rawPath, op, rename, language, metadataLine, isError, errorText };
}

function renderDiffOrPreview(
	uiTheme: Theme,
	details: EditToolDetails | EditToolPerFileResult | undefined,
	rawPath: string,
	expanded: boolean,
	editDiffPreview: DiffResult | DiffError | undefined,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
): string {
	if (isNonEmpty(details?.diff)) {
		return renderDiffSection(details.diff, rawPath, expanded, uiTheme, renderDiffFn);
	}
	if (!editDiffPreview) return "";
	if ("error" in editDiffPreview) {
		return `\n\n${uiTheme.fg("error", sanitizeRendererText(editDiffPreview.error, rawPath))}`;
	}
	if (isNonEmpty(editDiffPreview.diff)) {
		return renderDiffSection(editDiffPreview.diff, rawPath, expanded, uiTheme, renderDiffFn);
	}
	return "";
}

function renderSingleFileBody(
	inputs: SingleFileRenderInputs,
	width: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	details: EditToolDetails | EditToolPerFileResult | undefined,
): string[] {
	const { rawPath, op, rename, metadataLine, isError, errorText } = inputs;
	const { expanded, renderContext } = options;
	const editDiffPreview = renderContext?.editDiffPreview;
	const renderDiffFn = renderContext?.renderDiff ?? ((t: string) => t);

	const previewLine =
		editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined;
	const detailsLine = details && !isError ? details.firstChangedLine : undefined;
	const firstChangedLine = firstDefined(previewLine, detailsLine);
	const { description } = formatEditDescription(rawPath, uiTheme, { rename, firstChangedLine });

	const header = renderStatusLine(
		{
			icon: isError ? "error" : "success",
			title: getOperationTitle(op),
			description,
		},
		uiTheme,
	);
	let text = header;
	text += metadataLine;

	if (isError) {
		if (errorText !== "") {
			text += `\n\n${uiTheme.fg("error", sanitizeRendererText(errorText, rawPath))}`;
		}
	} else {
		text += renderDiffOrPreview(uiTheme, details, rawPath, expanded, editDiffPreview, renderDiffFn);
	}

	if (details?.diagnostics) {
		text += formatDiagnostics(details.diagnostics, expanded, uiTheme, (fp: string) =>
			uiTheme.getLangIcon(getLanguageFromPath(fp)),
		);
	}

	return width > 0 ? text.split("\n").flatMap(line => wrapEditRendererLine(line, width)) : text.split("\n");
}

function renderSingleFileResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args?: EditRenderArgs,
): Component {
	const inputs = resolveSingleFileInputs(result, options, uiTheme, args);
	const details = result.details;
	let cached: RenderCache | undefined;

	return {
		render(width) {
			const key = new Hasher().bool(options.expanded).u32(width).digest();
			if (cached?.key === key) return cached.lines;

			const lines = renderSingleFileBody(inputs, width, options, uiTheme, details);
			cached = { key, lines };
			return lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

function renderMultiFileResult(
	perFileResults: EditToolPerFileResult[],
	totalFiles: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
): Component {
	const fileComponents = perFileResults.map(fileResult =>
		renderSingleFileResult({ content: [], details: fileResult, isError: fileResult.isError }, options, uiTheme),
	);
	const remaining = Math.max(0, totalFiles - perFileResults.length);

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const key = new Hasher().bool(options.expanded).u32(width).u32(perFileResults.length).u32(remaining).digest();
			if (cached?.key === key) return cached.lines;

			const allLines: string[] = [];
			for (let i = 0; i < fileComponents.length; i++) {
				if (i > 0) {
					allLines.push("");
				}
				allLines.push(...fileComponents[i].render(width));
			}

			// Show pending indicator for files still being processed
			if (remaining > 0) {
				if (allLines.length > 0) allLines.push("");
				const spinnerFrame = options.spinnerFrame;
				const spinner = spinnerFrame === undefined ? "" : formatStatusIcon("running", uiTheme, spinnerFrame);
				allLines.push(
					renderStatusLine(
						{
							icon: "pending",
							title: "Edit",
							description: uiTheme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						uiTheme,
					),
				);
				if (spinner !== "") {
					// Replace the pending icon with spinner on the last line
					allLines[allLines.length - 1] = allLines[allLines.length - 1].replace(/^(?:\x1b\[[^m]*m)*./u, spinner);
				}
			}

			cached = { key, lines: allLines };
			return allLines;
		},
		invalidate() {
			cached = undefined;
			for (const c of fileComponents) c.invalidate();
		},
	};
}
