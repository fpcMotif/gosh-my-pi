import { sanitizeText } from "@oh-my-pi/pi-natives";
import { getIndentation } from "@oh-my-pi/pi-utils";
import * as Diff from "diff";
import { theme } from "../../modes/theme/theme";
import { type CodeFrameMarker, formatCodeFrameLine, replaceTabs } from "../../tools/render-utils";

/** SGR dim on / normal intensity — additive, preserves fg/bg colors. */
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

/**
 * Upper bound on the line-number gutter width. 9,999,999 lines covers every
 * realistic source file; values longer than this are clamped so the gutter
 * cannot starve the content column on narrow terminals.
 */
const MAX_LINE_NUMBER_WIDTH = 7;

/**
 * Visualize leading whitespace (indentation) with dim glyphs.
 * Tabs become ` → ` and spaces become `·`. Only affects whitespace
 * before the first non-whitespace character; remaining tabs in code
 * content are replaced with spaces (like replaceTabs).
 */
function visualizeIndent(text: string, filePath?: string): string {
	const match = text.match(/^([ \t]+)/);
	if (!match) return replaceTabs(text, filePath);
	const indent = match[1];
	const rest = text.slice(indent.length);
	const tabWidth = getIndentation(filePath);
	const leftPadding = Math.floor(tabWidth / 2);
	const rightPadding = Math.max(0, tabWidth - leftPadding - 1);
	const tabMarker = `${DIM}${" ".repeat(leftPadding)}→${" ".repeat(rightPadding)}${DIM_OFF}`;
	let visible = "";
	for (const ch of indent) {
		visible += ch === "\t" ? tabMarker : `${DIM}·${DIM_OFF}`;
	}
	return `${visible}${replaceTabs(rest, filePath)}`;
}

/**
 * Parse diff line to extract prefix, line number, and content.
 * Supported formats: "+123|content" (canonical) and "+123 content" (legacy).
 */
function parseDiffLine(line: string): { prefix: CodeFrameMarker; lineNum: string; content: string } | null {
	const canonical = line.match(/^([+-\s])(\s*\d+)\|(.*)$/);
	if (canonical) {
		return { prefix: canonical[1] as CodeFrameMarker, lineNum: canonical[2] ?? "", content: canonical[3] ?? "" };
	}
	const legacy = line.match(/^([+-\s])(?:(\s*\d+)\s)?(.*)$/);
	if (!legacy) return null;
	return { prefix: legacy[1] as CodeFrameMarker, lineNum: legacy[2] ?? "", content: legacy[3] ?? "" };
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed === true) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value !== "") {
				removedLine += theme.inverse(value);
			}
		} else if (part.added === true) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value !== "") {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path used to resolve indentation (.editorconfig + defaults) */
	filePath?: string;
}

type DiffLineEntry = { lineNum: string; content: string };

function collectPrefixedLines(
	lines: string[],
	startIndex: number,
	prefix: "-" | "+",
): { entries: DiffLineEntry[]; nextIndex: number } {
	const entries: DiffLineEntry[] = [];
	let i = startIndex;
	while (i < lines.length) {
		const p = parseDiffLine(lines[i]);
		if (!p || p.prefix !== prefix) break;
		entries.push({ lineNum: p.lineNum, content: p.content });
		i++;
	}
	return { entries, nextIndex: i };
}

function renderRemovedAddedBlock(
	removedLines: DiffLineEntry[],
	addedLines: DiffLineEntry[],
	formatLine: (prefix: CodeFrameMarker, lineNum: string, content: string) => string,
	options: RenderDiffOptions,
	result: string[],
): void {
	if (removedLines.length === 1 && addedLines.length === 1) {
		const removed = removedLines[0];
		const added = addedLines[0];
		const { removedLine, addedLine } = renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content));
		result.push(
			theme.fg("toolDiffRemoved", formatLine("-", removed.lineNum, visualizeIndent(removedLine, options.filePath))),
		);
		result.push(
			theme.fg("toolDiffAdded", formatLine("+", added.lineNum, visualizeIndent(addedLine, options.filePath))),
		);
		return;
	}
	for (const removed of removedLines) {
		result.push(
			theme.fg(
				"toolDiffRemoved",
				formatLine("-", removed.lineNum, visualizeIndent(removed.content, options.filePath)),
			),
		);
	}
	for (const added of addedLines) {
		result.push(
			theme.fg("toolDiffAdded", formatLine("+", added.lineNum, visualizeIndent(added.content, options.filePath))),
		);
	}
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const lines = sanitizeText(diffText).split("\n");
	const result: string[] = [];
	const parsedLines = lines.map(parseDiffLine);
	const rawMaxLineNumberWidth = parsedLines.reduce((width, parsed) => {
		const lineNumber = parsed?.lineNum.trim() ?? "";
		return Math.max(width, lineNumber.length);
	}, 0);
	// Clamp the gutter so absurd line numbers (>10M lines, hashes accidentally
	// emitted as line numbers) cannot monopolise the row and starve the content
	// column. 7 digits comfortably covers any realistic source file.
	const lineNumberWidth = Math.min(rawMaxLineNumberWidth, MAX_LINE_NUMBER_WIDTH);

	// Track the line number rendered on the previous emitted line so we can
	// blank out duplicate gutters. Two cases trigger this:
	//  1. Single-line replacement (`-N` followed by `+N`) — the `+N` repeats `N`.
	//  2. Insertion followed by context (`+N` then ` N` if producer used oldLine).
	let prevLineNum = "";

	const formatLine = (prefix: CodeFrameMarker, lineNum: string, content: string): string => {
		if (lineNum.trim().length === 0) {
			prevLineNum = "";
			return `${prefix}${content}`;
		}
		const trimmed = lineNum.trim();
		let displayNum = trimmed === prevLineNum ? "" : trimmed;
		// Truncate over-long line numbers to the clamp width so the rendered
		// gutter cannot exceed lineNumberWidth + sign + padding.
		if (displayNum.length > MAX_LINE_NUMBER_WIDTH) {
			displayNum = displayNum.slice(0, MAX_LINE_NUMBER_WIDTH);
		}
		prevLineNum = trimmed;
		return formatCodeFrameLine(prefix, displayNum, content, lineNumberWidth);
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			prevLineNum = "";
			result.push(theme.fg("toolDiffContext", replaceTabs(line, options.filePath)));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedResult = collectPrefixedLines(lines, i, "-");
			const addedResult = collectPrefixedLines(lines, removedResult.nextIndex, "+");
			i = addedResult.nextIndex;
			renderRemovedAddedBlock(removedResult.entries, addedResult.entries, formatLine, options, result);
			continue;
		}
		const themeColor = parsed.prefix === "+" ? "toolDiffAdded" : "toolDiffContext";
		const marker: CodeFrameMarker = parsed.prefix === "+" ? "+" : " ";
		result.push(
			theme.fg(themeColor, formatLine(marker, parsed.lineNum, visualizeIndent(parsed.content, options.filePath))),
		);
		i++;
	}

	return result.join("\n");
}
