/**
 * File verification for edit benchmark.
 *
 * Compares output files against expected fixtures with byte-for-byte equality.
 */
import * as path from "node:path";
import { diffLines } from "diff";
import { formatContent } from "./formatter";
import { listFiles } from "./shared";

export interface VerificationResult {
	success: boolean;
	error?: string;
	duration: number;
	indentScore?: number;
	formattedEquivalent?: boolean;
	diffStats?: DiffStats;
	diff?: string;
}

export interface DiffStats {
	linesChanged: number;
	charsChanged: number;
}

function formatFileList(files: string[]): string {
	return files.length === 0 ? "(none)" : files.join(", ");
}

function appendContextBefore(
	prevChange: { added?: boolean; removed?: boolean; value: string },
	output: string[],
	lineNum: number,
	contextLines: number,
): void {
	if (prevChange.added === true || prevChange.removed === true) return;
	const prevLines = splitLines(prevChange.value);
	const contextStart = Math.max(0, prevLines.length - contextLines);
	if (contextStart > 0) {
		output.push(`@@ -${lineNum - (prevLines.length - contextStart)} @@`);
	}
	for (let j = contextStart; j < prevLines.length; j++) {
		output.push(` ${prevLines[j]}`);
	}
}

function appendContextAfter(
	nextChange: { added?: boolean; removed?: boolean; value: string },
	output: string[],
	contextLines: number,
): void {
	if (nextChange.added === true || nextChange.removed === true) return;
	const nextLines = splitLines(nextChange.value);
	const contextEnd = Math.min(nextLines.length, contextLines);
	for (let j = 0; j < contextEnd; j++) {
		output.push(` ${nextLines[j]}`);
	}
}

function appendChangeOutput(
	change: { added?: boolean; removed?: boolean; value: string },
	prev: { added?: boolean; removed?: boolean; value: string } | undefined,
	next: { added?: boolean; removed?: boolean; value: string } | undefined,
	output: string[],
	lineNum: number,
	contextLines: number,
): void {
	if (prev !== undefined) {
		appendContextBefore(prev, output, lineNum, contextLines);
	}
	const prefix = change.added === true ? "+" : "-";
	const lines = splitLines(change.value);
	for (const line of lines) {
		output.push(`${prefix}${line}`);
	}
	if (next !== undefined) {
		appendContextAfter(next, output, contextLines);
	}
}

function createCompactDiff(expected: string, actual: string, contextLines = 3): string {
	const changes = diffLines(expected, actual);
	const output: string[] = [];
	let lineNum = 1;

	for (let i = 0; i < changes.length; i++) {
		const change = changes[i];
		if (change === undefined) continue;
		const lines = splitLines(change.value);

		if (change.added !== true && change.removed !== true) {
			lineNum += lines.length;
			continue;
		}

		const prev = i > 0 ? changes[i - 1] : undefined;
		const next = i + 1 < changes.length ? changes[i + 1] : undefined;
		appendChangeOutput(change, prev, next, output, lineNum, contextLines);

		if (change.added !== true) {
			lineNum += lines.length;
		}
	}

	return output.join("\n");
}

export async function verifyExpectedFiles(expectedDir: string, actualDir: string): Promise<VerificationResult> {
	return verifyExpectedFileSubset(expectedDir, actualDir);
}

interface FilePresenceCheck {
	error?: string;
	expectedFiles: string[];
}

async function checkFilePresence(expectedDir: string, actualDir: string, files?: string[]): Promise<FilePresenceCheck> {
	const [expectedFixtureFiles, actualFiles] = await Promise.all([listFiles(expectedDir), listFiles(actualDir)]);
	const expectedFiles = files !== undefined && files.length > 0 ? files.slice().sort() : expectedFixtureFiles;

	const missingFiles = expectedFiles.filter(file => !actualFiles.includes(file));
	const extraFiles = actualFiles.filter(file => !expectedFiles.includes(file));
	const missingExpected = expectedFiles.filter(file => !expectedFixtureFiles.includes(file));

	if (missingExpected.length > 0) {
		return { expectedFiles, error: `Expected files missing from fixture: ${formatFileList(missingExpected)}` };
	}

	if (missingFiles.length > 0 || (files === undefined && extraFiles.length > 0)) {
		const parts: string[] = [];
		if (missingFiles.length > 0) {
			parts.push(`Missing files: ${formatFileList(missingFiles)}`);
		}
		if (files === undefined && extraFiles.length > 0) {
			parts.push(`Unexpected files: ${formatFileList(extraFiles)}`);
		}
		return { expectedFiles, error: parts.join("; ") };
	}

	return { expectedFiles };
}

interface FileComparison {
	indentScore: number;
	mismatch?: { file: string; diff: string; diffStats: DiffStats };
}

async function compareSingleFile(expectedDir: string, actualDir: string, file: string): Promise<FileComparison> {
	const expectedPath = path.join(expectedDir, file);
	const actualPath = path.join(actualDir, file);
	const [expectedRaw, actualRaw] = await Promise.all([Bun.file(expectedPath).text(), Bun.file(actualPath).text()]);
	const expectedNormalized = normalizeLineEndings(expectedRaw);
	const actualNormalized = normalizeLineEndings(actualRaw);
	const actualNormalizedWithPreservedWhitespace = restoreWhitespaceOnlyLineDiffs(expectedNormalized, actualNormalized);
	const [expectedFormatted, actualFormatted] = await Promise.all([
		formatContent(expectedPath, normalizeBlankLines(expectedNormalized)),
		formatContent(actualPath, normalizeBlankLines(actualNormalizedWithPreservedWhitespace)),
	]);
	const formattedEquivalent = expectedFormatted.formatted === actualFormatted.formatted;
	const indentScore = computeIndentDistanceForDiff(actualNormalized, actualFormatted.formatted);

	if (!formattedEquivalent) {
		const diff = createCompactDiff(expectedFormatted.formatted, actualFormatted.formatted);
		const diffStats = computeDiffStats(expectedFormatted.formatted, actualFormatted.formatted);
		return { indentScore, mismatch: { file, diff, diffStats } };
	}

	return { indentScore };
}

export async function verifyExpectedFileSubset(
	expectedDir: string,
	actualDir: string,
	files?: string[],
): Promise<VerificationResult> {
	const startTime = Date.now();

	try {
		const presence = await checkFilePresence(expectedDir, actualDir, files);
		if (presence.error !== undefined) {
			return {
				success: false,
				error: presence.error,
				duration: Date.now() - startTime,
			};
		}

		const comparisons = await Promise.all(
			presence.expectedFiles.map(file => compareSingleFile(expectedDir, actualDir, file)),
		);
		let totalIndentScore = 0;
		let fileCount = 0;
		for (const comparison of comparisons) {
			totalIndentScore += comparison.indentScore;
			fileCount++;
			if (comparison.mismatch !== undefined) {
				return {
					success: false,
					error: `File mismatch for ${comparison.mismatch.file}`,
					duration: Date.now() - startTime,
					diff: comparison.mismatch.diff,
					diffStats: comparison.mismatch.diffStats,
					indentScore: comparison.indentScore,
					formattedEquivalent: false,
				};
			}
		}

		return {
			success: true,
			duration: Date.now() - startTime,
			indentScore: fileCount > 0 ? totalIndentScore / fileCount : 0,
			formattedEquivalent: true,
			diffStats: { linesChanged: 0, charsChanged: 0 },
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			duration: Date.now() - startTime,
		};
	}
}

function computeDiffStats(expected: string, actual: string): DiffStats {
	const changes = diffLines(expected, actual);
	let linesChanged = 0;
	let charsChanged = 0;

	for (const change of changes) {
		if (change.added !== true && change.removed !== true) {
			continue;
		}
		const lines = splitLines(change.value);
		linesChanged += lines.length;
		charsChanged += change.value.length;
	}

	return { linesChanged, charsChanged };
}

function computeIndentDistanceForDiff(expected: string, actual: string): number {
	const changes = diffLines(expected, actual);
	let totalDistance = 0;
	let samples = 0;
	let pendingRemoved: string[] = [];
	let pendingAdded: string[] = [];

	const flush = (): void => {
		const max = Math.max(pendingRemoved.length, pendingAdded.length);
		for (let i = 0; i < max; i++) {
			const removedLine = pendingRemoved[i] ?? "";
			const addedLine = pendingAdded[i] ?? "";
			totalDistance += Math.abs(countIndent(removedLine) - countIndent(addedLine));
			samples += 1;
		}
		pendingRemoved = [];
		pendingAdded = [];
	};

	for (const change of changes) {
		const lines = splitLines(change.value);
		if (change.removed === true) {
			pendingRemoved.push(...lines);
			continue;
		}
		if (change.added === true) {
			pendingAdded.push(...lines);
			continue;
		}
		if (pendingRemoved.length > 0 || pendingAdded.length > 0) {
			flush();
		}
	}
	if (pendingRemoved.length > 0 || pendingAdded.length > 0) {
		flush();
	}

	return samples > 0 ? totalDistance / samples : 0;
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Collapse runs of 2+ blank lines into a single blank line. */
function normalizeBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n");
}

function restoreWhitespaceOnlyLineDiffs(expected: string, actual: string): string {
	const expectedLines = expected.split("\n");
	const actualLines = actual.split("\n");
	const max = Math.max(expectedLines.length, actualLines.length);
	const out = Array.from<string>({ length: max });

	for (let i = 0; i < max; i++) {
		const expectedLine = expectedLines[i];
		const actualLine = actualLines[i];
		if (expectedLine === undefined || actualLine === undefined) {
			out[i] = actualLine ?? "";
			continue;
		}

		out[i] =
			expectedLine !== actualLine && equalsIgnoringWhitespace(expectedLine, actualLine) ? expectedLine : actualLine;
	}

	return out.join("\n");
}

function equalsIgnoringWhitespace(a: string, b: string): boolean {
	return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function splitLines(value: string): string[] {
	return value.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0);
}

function countIndent(line: string): number {
	let count = 0;
	for (const char of line) {
		if (char === " ") {
			count += 1;
		} else if (char === "\t") {
			count += 2;
		} else {
			break;
		}
	}
	return count;
}
