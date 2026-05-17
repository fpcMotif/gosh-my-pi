import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallContext } from "@oh-my-pi/pi-agent-core";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	dedupeParseErrors,
	formatBadge,
	formatCodeFrameLine,
	formatDiagnostics,
	formatDiffStats,
	formatEmptyMessage,
	formatErrorMessage,
	formatExpandHint,
	formatMeta,
	formatMoreItems,
	formatParseErrors,
	formatScreenshot,
	formatStatusIcon,
	formatTitle,
	formatToolWorkingDirectory,
	getDiffStats,
	getDomain,
	getLspBatchRequest,
	getPreviewLines,
	shortenPath,
	truncateDiffByHunk,
} from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import type { Theme } from "../../src/modes/theme/theme";

async function loadTheme(): Promise<Theme> {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Expected dark theme to load");
	}
	return theme;
}

describe("parse error formatting", () => {
	it("deduplicates parse errors while preserving order", () => {
		const errors = [
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
		];

		expect(dedupeParseErrors(errors)).toEqual([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});

	it("formats deduplicated parse errors", () => {
		const formatted = formatParseErrors([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);

		expect(formatted).toEqual([
			"Parse issues:",
			"- foo.ts: parse error (syntax tree contains error nodes)",
			"- bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});

	it("returns no parse-error block for empty input and caps long lists", () => {
		expect(dedupeParseErrors(undefined)).toEqual([]);
		expect(formatParseErrors([])).toEqual([]);

		const errors = Array.from({ length: 25 }, (_, index) => `file-${index}.ts: parse error`);
		const formatted = formatParseErrors(errors);

		expect(formatted[0]).toBe("Parse issues (20 / 25):");
		expect(formatted).toHaveLength(21);
		expect(formatted.at(-1)).toBe("- file-19.ts: parse error");
	});
});

describe("basic renderer helpers", () => {
	it("previews trimmed non-empty lines and extracts domains safely", () => {
		expect(getPreviewLines("  first line  \n\nsecond line\nthird line", 2, 20)).toEqual([
			"first line",
			"second line",
		]);
		expect(getDomain("https://www.example.com/docs?q=1")).toBe("example.com");
		expect(getDomain("not a url")).toBe("not a url");
	});

	it("formats status, badge, metadata, and empty/error messages through the theme", async () => {
		const theme = await loadTheme();
		const runningFrame = theme.spinnerFrames[1 % theme.spinnerFrames.length];

		expect(formatStatusIcon("running", theme, 1)).toBe(runningFrame);
		for (const status of ["success", "error", "warning", "info", "pending", "aborted"] as const) {
			expect(Bun.stripANSI(formatStatusIcon(status, theme))).not.toBe("");
		}
		expect(Bun.stripANSI(formatStatusIcon("running", theme))).not.toBe("");
		expect(Bun.stripANSI(formatBadge("done", "success", theme))).toContain("done");
		expect(Bun.stripANSI(formatTitle("Plain title", theme, { bold: false }))).toBe("Plain title");
		expect(Bun.stripANSI(formatMeta(["a", "b"], theme))).toContain("a");
		expect(formatMeta([], theme)).toBe("");
		expect(Bun.stripANSI(formatErrorMessage("Error: denied", theme))).toContain("Error: denied");
		expect(Bun.stripANSI(formatErrorMessage(undefined, theme))).toContain("Unknown error");
		expect(Bun.stripANSI(formatEmptyMessage("No rows", theme))).toContain("No rows");
	});

	it("only shows expand hints when collapsed content has hidden rows", async () => {
		const theme = await loadTheme();

		expect(formatExpandHint(theme, true, true)).toBe("");
		expect(formatExpandHint(theme, false, false)).toBe("");
		expect(Bun.stripANSI(formatExpandHint(theme, false, true))).toContain("Ctrl+O for more");
		expect(formatMoreItems(Number.NaN, "line")).toBe("… 0 more lines");
		expect(formatMoreItems(1, "line")).toBe("… 1 more line");
		expect(formatMoreItems(2, "line")).toBe("… 2 more lines");
	});
});

describe("formatScreenshot", () => {
	function fakeResized(
		overrides?: Partial<{
			width: number;
			height: number;
			originalWidth: number;
			originalHeight: number;
			wasResized: boolean;
			buffer: Uint8Array;
			mimeType: string;
		}>,
	): {
		buffer: Uint8Array;
		mimeType: string;
		originalWidth: number;
		originalHeight: number;
		width: number;
		height: number;
		wasResized: boolean;
		get data(): string;
	} {
		const buf = overrides?.buffer ?? new Uint8Array(2048);
		return {
			buffer: buf,
			mimeType: overrides?.mimeType ?? "image/webp",
			originalWidth: overrides?.originalWidth ?? 800,
			originalHeight: overrides?.originalHeight ?? 600,
			width: overrides?.width ?? 800,
			height: overrides?.height ?? 600,
			wasResized: overrides?.wasResized ?? false,
			get data() {
				return Buffer.from(buf).toString("base64");
			},
		};
	}

	it("formats full-res save with home-relative path", () => {
		const filePath = path.join(os.homedir(), "screenshots", "capture.png");
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: filePath,
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			"Saved: image/png (2.00 KB) to ~/screenshots/capture.png",
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("formats non-home path without tilde", () => {
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: "/tmp/capture.png",
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			"Saved: image/png (2.00 KB) to /tmp/capture.png",
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("formats temp-only screenshot without save line", () => {
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(3072) });

		expect(
			formatScreenshot({
				saveFullRes: false,
				savedMimeType: "image/webp",
				savedByteLength: 3072,
				dest: "/tmp/omp-sshots-123.png",
				resized,
			}),
		).toEqual(["Screenshot captured", "Format: image/webp (3.00 KB)", "Dimensions: 800x600"]);
	});

	it("appends dimension note when image was resized", () => {
		const resized = fakeResized({
			wasResized: true,
			originalWidth: 1600,
			originalHeight: 1200,
			width: 800,
			height: 600,
		});

		const lines = formatScreenshot({
			saveFullRes: false,
			savedMimeType: "image/webp",
			savedByteLength: 2048,
			dest: "/tmp/shot.png",
			resized,
		});

		expect(lines).toContain(
			"[Image: original 1600x1200, displayed at 800x600. Multiply coordinates by 2.00 to map to original image.]",
		);
	});
});

describe("formatDiagnostics", () => {
	it("returns an empty string when there are no diagnostic messages", async () => {
		const theme = await loadTheme();

		expect(formatDiagnostics({ errored: false, summary: "0 warnings", messages: [] }, false, theme, () => "ts")).toBe(
			"",
		);
	});

	it("replaces tabs in rendered diagnostic text", async () => {
		const theme = await loadTheme();

		const formatted = formatDiagnostics(
			{
				errored: true,
				summary: "1\terror(s)",
				messages: [
					"src/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					"\tunparsed diagnostic\tmessage",
				],
			},
			true,
			theme,
			() => "go",
		);

		expect(formatted).not.toContain("\t");
		expect(formatted.replace(/\s+/g, " ")).toContain("too many arguments in call");
		expect(formatted.replace(/\s+/g, " ")).toContain("unparsed diagnostic message");
		expect(formatted.replace(/\s+/g, " ")).toContain("1 error(s)");
	});

	it("sorts parsed diagnostics by severity and reports hidden collapsed rows", async () => {
		const theme = await loadTheme();

		const formatted = Bun.stripANSI(
			formatDiagnostics(
				{
					errored: false,
					summary: "6 diagnostics",
					messages: [
						"src/a.ts:5:1 [hint] low priority",
						"src/a.ts:3:1 [warning] warn first",
						"src/a.ts:1:1 [error] error first (E001)",
						"src/a.ts:4:1 [info] info next",
						"src/b.ts:1:1 [warning] another warning",
						"raw [warning] fallback",
					],
				},
				false,
				theme,
				() => "ts",
			),
		);

		expect(formatted.indexOf("error first")).toBeLessThan(formatted.indexOf("warn first"));
		expect(formatted.indexOf("warn first")).toBeLessThan(formatted.indexOf("info next"));
		expect(formatted).toContain("(E001)");
		expect(formatted).toContain("1 more");
		expect(formatted).toContain("Ctrl+O for more");
		expect(formatted).not.toContain("raw [warning] fallback");
	});

	it("orders same-severity diagnostics by line, column, and message in expanded output", async () => {
		const theme = await loadTheme();

		const formatted = Bun.stripANSI(
			formatDiagnostics(
				{
					errored: true,
					summary: "4 errors",
					messages: [
						"src/a.ts:2:3 [error] c message",
						"src/a.ts:1:9 [error] b message",
						"src/a.ts:1:2 [error] z message",
						"src/a.ts:1:2 [error] a message",
					],
				},
				true,
				theme,
				() => "ts",
			),
		);

		expect(formatted.indexOf("a message")).toBeLessThan(formatted.indexOf("z message"));
		expect(formatted.indexOf("z message")).toBeLessThan(formatted.indexOf("b message"));
		expect(formatted.indexOf("b message")).toBeLessThan(formatted.indexOf("c message"));
		expect(formatted).not.toContain("more");
	});
});

describe("formatCodeFrameLine", () => {
	it("pads markers as part of the gutter", () => {
		expect(formatCodeFrameLine(" ", 447, "context", 3)).toBe(" 447│context");
		expect(formatCodeFrameLine("*", 448, "match", 3)).toBe("*448│match");
		expect(formatCodeFrameLine("+", 11, "added", 3)).toBe(" +11│added");
		expect(formatCodeFrameLine("+", 235, "added", 3)).toBe("+235│added");
	});
});

describe("diff and path renderer helpers", () => {
	it("counts diff hunks and formats non-empty diff stats", async () => {
		const theme = await loadTheme();
		const diff = ["+one", "+two", " context", "-old"].join("\n");

		expect(getDiffStats(diff)).toEqual({ added: 2, removed: 1, hunks: 2, lines: 4 });
		const formatted = Bun.stripANSI(formatDiffStats(2, 1, 2, theme));
		expect(formatted).toContain("+2");
		expect(formatted).toContain("-1");
		expect(formatted).toContain("2 hunks");
		expect(formatDiffStats(0, 0, 0, theme)).toBe("");
	});

	it("truncates large diffs by changed lines before falling back to context trimming", () => {
		const changeHeavy = ["+one", "+two", " context", "-old", "-older", " tail"].join("\n");
		const changeLimited = truncateDiffByHunk(changeHeavy, 1, 2);

		expect(changeLimited.text).toBe("+one\n+two");
		expect(changeLimited.hiddenHunks).toBe(1);
		expect(changeLimited.hiddenLines).toBe(4);

		const contextHeavy = [
			"before one",
			"before two",
			"+added",
			"middle one",
			"middle two",
			"middle three",
			"-removed",
			"after one",
			"after two",
		].join("\n");
		const contextLimited = truncateDiffByHunk(contextHeavy, 3, 5);

		expect(contextLimited.text).toContain("+added");
		expect(contextLimited.text).toContain("-removed");
		expect(contextLimited.hiddenLines).toBeGreaterThan(0);
	});

	it("returns already-small diffs unchanged and preserves explicit ellipsis markers", () => {
		const smallDiff = [" context", "+added"].join("\n");
		expect(truncateDiffByHunk(smallDiff, 1, 2)).toEqual({
			text: smallDiff,
			hiddenHunks: 0,
			hiddenLines: 0,
		});

		const diffWithEllipsis = ["before", "...", "+added", "after one", "after two"].join("\n");
		const truncated = truncateDiffByHunk(diffWithEllipsis, 2, 3);

		expect(truncated.text).toContain("...");
		expect(truncated.text).toContain("+added");
		expect(truncated.hiddenLines).toBeGreaterThan(0);
	});

	it("shortens home paths and formats working directories relative to the project", () => {
		const home = "/Users/tester";

		expect(shortenPath("/Users/tester/project/file.ts", home)).toBe("~/project/file.ts");
		expect(shortenPath("/tmp/file.ts", home)).toBe("/tmp/file.ts");
		expect(formatToolWorkingDirectory(undefined, "/repo")).toBeUndefined();
		expect(formatToolWorkingDirectory(".", "/repo")).toBeUndefined();
		expect(formatToolWorkingDirectory("src", "/repo")).toBe("src");
		expect(formatToolWorkingDirectory("docs\tapi", "/repo")).toBe("docs   api");
		expect(formatToolWorkingDirectory("../outside", "/repo")).toBe(path.resolve("/repo", "../outside"));
	});
});

describe("getLspBatchRequest", () => {
	it("returns no batch when there are no sibling write-like calls", () => {
		const context: ToolCallContext = {
			batchId: "batch-1",
			index: 0,
			total: 2,
			toolCalls: [
				{ id: "read-1", name: "read" },
				{ id: "bash-1", name: "bash" },
			],
		};

		expect(getLspBatchRequest(undefined)).toBeUndefined();
		expect(getLspBatchRequest(context)).toBeUndefined();
	});

	it("flushes only the last write-like call in an LSP batch", () => {
		const firstWrite: ToolCallContext = {
			batchId: "batch-2",
			index: 0,
			total: 3,
			toolCalls: [
				{ id: "write-1", name: "write" },
				{ id: "read-1", name: "read" },
				{ id: "edit-1", name: "edit" },
			],
		};
		const lastWrite: ToolCallContext = { ...firstWrite, index: 2 };

		expect(getLspBatchRequest(firstWrite)).toEqual({ id: "batch-2", flush: false });
		expect(getLspBatchRequest(lastWrite)).toEqual({ id: "batch-2", flush: true });
	});
});
