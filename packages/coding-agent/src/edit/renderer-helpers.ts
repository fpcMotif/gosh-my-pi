/**
 * Helper utilities used by the edit tool renderer.
 */
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { type Theme } from "../modes/theme/theme";
import {
	formatExpandHint,
	getDiffStats,
	formatDiffStats,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	truncateDiffByHunk,
} from "../tools/render-utils";
import { truncateToWidth } from "../tui";
import type { EditMode } from "../utils/edit-mode";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import type { Operation } from "./modes/patch";
import type { PerFileDiffPreview } from "./streaming";

export const EDIT_STREAMING_PREVIEW_LINES = 12;
export const CALL_TEXT_PREVIEW_LINES = 6;
export const CALL_TEXT_PREVIEW_WIDTH = 80;
export const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";
const ATOM_HEADER_PREFIX = "---";

export interface EditRenderEntry {
	path?: string;
	rename?: string;
	move?: string;
	op?: Operation;
}

export interface AtomRenderSummary {
	entries: Array<{ path: string }>;
}

export interface ApplyPatchRenderSummary {
	entries: ApplyPatchEntry[];
	error?: string;
}

export interface EditRenderArgs {
	path?: string;
	file_path?: string;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	all?: boolean;
	op?: Operation;
	rename?: string;
	diff?: string;
	previewDiff?: string;
	__partialJson?: string;
	edits?: EditRenderEntry[];
}

export function isNonEmpty(value: string | null | undefined): value is string {
	return value !== null && value !== undefined && value !== "";
}

export function filePathFromEditEntry(p: string | undefined): string | undefined {
	return isNonEmpty(p) ? p : undefined;
}

function decodePartialJsonStringFragment(fragment: string): string {
	let text = fragment.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		return text;
	}
}

function extractPartialJsonString(partialJson: string | undefined, key: string): string | undefined {
	if (!isNonEmpty(partialJson)) return undefined;
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "u");
	const match = pattern.exec(partialJson);
	if (!match) return undefined;
	return decodePartialJsonStringFragment(match[1]);
}

export function getPartialJsonEditPath(args: EditRenderArgs): string | undefined {
	return filePathFromEditEntry(extractPartialJsonString(args.__partialJson, "path"));
}

export function countEditFiles(edits: EditRenderEntry[]): number {
	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;
}

export function countLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length;
}

export function getOperationTitle(op: Operation | undefined): string {
	if (op === "create") return "Create";
	if (op === "delete") return "Delete";
	return "Edit";
}

export function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): string {
	let pathDisplay = rawPath === "" ? uiTheme.fg("toolOutput", "…") : uiTheme.fg("accent", shortenPath(rawPath));

	const firstChangedLine = options?.firstChangedLine;
	if (firstChangedLine !== null && firstChangedLine !== undefined && firstChangedLine !== 0) {
		pathDisplay += uiTheme.fg("warning", `:${firstChangedLine}`);
	}

	if (isNonEmpty(options?.rename)) {
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${uiTheme.fg("accent", shortenPath(options.rename))}`;
	}

	return pathDisplay;
}

export function renderPlainTextPreview(text: string, uiTheme: Theme, filePath?: string): string {
	const previewLines = sanitizeText(text).split("\n");
	let preview = "\n\n";
	for (const line of previewLines.slice(0, CALL_TEXT_PREVIEW_LINES)) {
		preview += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line, filePath), CALL_TEXT_PREVIEW_WIDTH))}\n`;
	}
	if (previewLines.length > CALL_TEXT_PREVIEW_LINES) {
		preview += uiTheme.fg("dim", `… ${previewLines.length - CALL_TEXT_PREVIEW_LINES} more lines`);
	}
	return preview.trimEnd();
}

export function sanitizeRendererText(text: string, filePath?: string): string {
	return replaceTabs(sanitizeText(text), filePath);
}

export function formatStreamingDiff(diff: string, rawPath: string, uiTheme: Theme, label = "streaming"): string {
	if (diff === "") return "";
	const lines = diff.split("\n");
	const total = lines.length;
	const displayLines = lines.slice(-EDIT_STREAMING_PREVIEW_LINES);
	const hidden = total - displayLines.length;
	let text = "\n\n";
	if (hidden > 0) {
		text += uiTheme.fg("dim", `… (${hidden} earlier lines)\n`);
	}
	text += renderDiffColored(displayLines.join("\n"), { filePath: rawPath });
	text += uiTheme.fg("dim", `\n… (${label})`);
	return text;
}

export function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

export function formatMultiFileStreamingDiff(previews: PerFileDiffPreview[], uiTheme: Theme): string {
	const parts: string[] = [];
	for (const preview of previews) {
		const hasDiff = isNonEmpty(preview.diff);
		const hasError = isNonEmpty(preview.error);
		if (!hasDiff && !hasError) continue;
		const header = uiTheme.fg("dim", `\n\n── ${shortenPath(preview.path)} ──`);
		if (hasError) {
			parts.push(`${header}\n${uiTheme.fg("error", replaceTabs(preview.error ?? "", preview.path))}`);
			continue;
		}
		if (hasDiff) {
			parts.push(`${header}${formatStreamingDiff(preview.diff ?? "", preview.path, uiTheme, "preview")}`);
		}
	}
	return parts.join("");
}

export interface EditRenderContextLite {
	editMode?: EditMode;
	perFileDiffPreview?: PerFileDiffPreview[];
}

export function getCallPreview(
	args: EditRenderArgs,
	rawPath: string,
	uiTheme: Theme,
	renderContext: EditRenderContextLite | undefined,
): string {
	const multi = renderContext?.perFileDiffPreview;
	if (multi && multi.length > 1 && multi.some(p => isNonEmpty(p.diff) || isNonEmpty(p.error))) {
		return formatMultiFileStreamingDiff(multi, uiTheme);
	}
	if (isNonEmpty(args.previewDiff)) {
		return formatStreamingDiff(args.previewDiff, rawPath, uiTheme, "preview");
	}
	if (isNonEmpty(args.diff) && args.op !== undefined) {
		return formatStreamingDiff(args.diff, rawPath, uiTheme);
	}
	if (isNonEmpty(args.diff)) {
		return renderPlainTextPreview(args.diff, uiTheme, rawPath);
	}
	const fallback = args.newText ?? (isNonEmpty(args.patch) ? args.patch : undefined);
	if (isNonEmpty(fallback)) {
		return renderPlainTextPreview(fallback, uiTheme, rawPath);
	}
	return "";
}

function normalizeAtomPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseAtomPreviewHeader(line: string): string | null {
	if (!line.startsWith(ATOM_HEADER_PREFIX)) return null;
	let body = line.slice(ATOM_HEADER_PREFIX.length);
	if (body.startsWith(" ")) body = body.slice(1);
	const previewPath = normalizeAtomPreviewPath(body);
	return previewPath.length > 0 ? previewPath : null;
}

function getAtomInputPaths(input: string): string[] {
	const stripped = input.startsWith("﻿") ? input.slice(1) : input;
	const paths: string[] = [];
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const path = parseAtomPreviewHeader(line);
		if (isNonEmpty(path)) paths.push(path);
	}
	return paths;
}

export function getAtomRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): AtomRenderSummary | undefined {
	if (editMode !== "atom" || typeof args.input !== "string") {
		return undefined;
	}
	return { entries: getAtomInputPaths(args.input).map(path => ({ path })) };
}

export function getApplyPatchRenderSummary(
	args: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): ApplyPatchRenderSummary | undefined {
	if (editMode !== undefined && editMode !== "apply_patch") {
		return undefined;
	}

	if (typeof args.input !== "string") {
		return undefined;
	}

	try {
		return { entries: expandApplyPatchToEntries({ input: args.input }) };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (isPartial && errorMessage === MISSING_APPLY_PATCH_END_ERROR) {
			return { entries: expandApplyPatchToPreviewEntries({ input: args.input }) };
		}
		return { entries: [], error: errorMessage };
	}
}

export function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
): string {
	let text = "";
	const diffStats = getDiffStats(diff);
	text += `\n${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${formatDiffStats(
		diffStats.added,
		diffStats.removed,
		diffStats.hunks,
		uiTheme,
	)}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;

	const {
		text: truncatedDiff,
		hiddenHunks,
		hiddenLines,
	} = expanded
		? { text: diff, hiddenHunks: 0, hiddenLines: 0 }
		: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

	text += `\n\n${renderDiffFn(truncatedDiff, { filePath: rawPath })}`;
	if (!expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
		const remainder: string[] = [];
		if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
		if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
		text += uiTheme.fg("toolOutput", `\n… (${remainder.join(", ")}) ${formatExpandHint(uiTheme)}`);
	}
	return text;
}

export function wrapEditRendererLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith("\x1b[39m") ? bodyWithReset.slice(0, -"\x1b[39m".length) : bodyWithReset;
	const diffMatch = /^([+\-\s])(\s*\d+)([|│])(.*)$/s.exec(body);

	if (!diffMatch) {
		return wrapTextWithAnsi(line, width);
	}

	const [, marker, lineNum, separator, content] = diffMatch;
	const prefix = `${marker}${lineNum}${separator}`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}${separator}`;
	const wrappedContent = wrapTextWithAnsi(content ?? "", contentWidth);

	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[39m`,
	);
}
