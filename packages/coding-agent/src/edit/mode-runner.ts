import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { HashlineMismatchError } from "./modes/hashline";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "./renderer";

interface PerFileEntry {
	path: string;
	run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
}

function buildBatchRequest(
	outerBatchRequest: LspBatchRequest | undefined,
	isLast: boolean,
): LspBatchRequest | undefined {
	if (!outerBatchRequest) return undefined;
	return { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush };
}

function appendPerFileEntry(
	entry: PerFileEntry,
	result: AgentToolResult<EditToolDetails>,
	perFileResults: EditToolPerFileResult[],
	contentTexts: string[],
): void {
	const details = result.details;
	perFileResults.push({
		path: entry.path,
		diff: details?.diff ?? "",
		firstChangedLine: details?.firstChangedLine,
		diagnostics: details?.diagnostics,
		op: details?.op,
		move: details?.move,
		meta: details?.meta,
	});
	const text = result.content?.find(c => c.type === "text")?.text ?? "";
	if (text !== "") contentTexts.push(text);
}

function appendPerFileError(
	entry: PerFileEntry,
	error: unknown,
	perFileResults: EditToolPerFileResult[],
	contentTexts: string[],
): void {
	const errorText = error instanceof Error ? error.message : String(error);
	const displayErrorText = error instanceof HashlineMismatchError ? error.displayMessage : undefined;
	perFileResults.push({ path: entry.path, diff: "", isError: true, errorText, displayErrorText });
	contentTexts.push(`Error editing ${entry.path}: ${errorText}`);
}

function buildPartialResult(
	contentTexts: string[],
	perFileResults: EditToolPerFileResult[],
): AgentToolResult<EditToolDetails> {
	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine !== undefined)?.firstChangedLine,
			perFileResults: [...perFileResults],
		},
	};
}

async function processSingleFileEntry(
	entry: PerFileEntry,
	outerBatchRequest: LspBatchRequest | undefined,
	isLast: boolean,
	perFileResults: EditToolPerFileResult[],
	contentTexts: string[],
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails>) => void,
): Promise<void> {
	const batchRequest = buildBatchRequest(outerBatchRequest, isLast);
	try {
		const result = await entry.run(batchRequest);
		appendPerFileEntry(entry, result, perFileResults, contentTexts);
	} catch (error) {
		appendPerFileError(entry, error, perFileResults, contentTexts);
	}

	// Emit partial result after each file so UI shows progressive completion
	if (!isLast && onUpdate) {
		onUpdate(buildPartialResult(contentTexts, perFileResults));
	}
}

/** Run apply_patch file operations and aggregate their multi-file result. */
export async function executeApplyPatchPerFile(
	fileEntries: PerFileEntry[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails>) => void,
): Promise<AgentToolResult<EditToolDetails>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];

	// Sequential chain via Promise reduction to keep ordering for progress updates.
	await fileEntries.reduce<Promise<void>>(
		(prior, entry, i) =>
			prior.then(() =>
				processSingleFileEntry(
					entry,
					outerBatchRequest,
					i === fileEntries.length - 1,
					perFileResults,
					contentTexts,
					onUpdate,
				),
			),
		Promise.resolve(),
	);

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine !== undefined)?.firstChangedLine,
			perFileResults,
		},
	};
}

interface SinglePathState {
	contentTexts: string[];
	diffTexts: string[];
	firstChangedLine: number | undefined;
}

function appendSinglePathResult(state: SinglePathState, result: AgentToolResult<EditToolDetails>): void {
	const details = result.details;
	const diff = details?.diff;
	if (diff !== null && diff !== undefined && diff !== "") {
		state.diffTexts.push(diff);
	}
	state.firstChangedLine ??= details?.firstChangedLine;
	const text = result.content?.find(c => c.type === "text")?.text ?? "";
	if (text !== "") state.contentTexts.push(text);
}

async function processSinglePathRun(
	run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>,
	path: string,
	outerBatchRequest: LspBatchRequest | undefined,
	isLast: boolean,
	state: SinglePathState,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails>) => void,
): Promise<void> {
	const batchRequest = buildBatchRequest(outerBatchRequest, isLast);
	try {
		const result = await run(batchRequest);
		appendSinglePathResult(state, result);
	} catch (error) {
		const errorText = error instanceof Error ? error.message : String(error);
		state.contentTexts.push(`Error editing ${path}: ${errorText}`);
	}

	if (!isLast && onUpdate) {
		onUpdate({
			content: [{ type: "text", text: state.contentTexts.join("\n") }],
			details: {
				diff: state.diffTexts.join("\n"),
				firstChangedLine: state.firstChangedLine,
			},
		});
	}
}

export async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails>) => void,
): Promise<AgentToolResult<EditToolDetails>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const state: SinglePathState = { contentTexts: [], diffTexts: [], firstChangedLine: undefined };

	await runs.reduce<Promise<void>>(
		(prior, run, i) =>
			prior.then(() => processSinglePathRun(run, path, outerBatchRequest, i === runs.length - 1, state, onUpdate)),
		Promise.resolve(),
	);

	return {
		content: [{ type: "text", text: state.contentTexts.join("\n") }],
		details: {
			diff: state.diffTexts.join("\n"),
			firstChangedLine: state.firstChangedLine,
		},
	};
}
