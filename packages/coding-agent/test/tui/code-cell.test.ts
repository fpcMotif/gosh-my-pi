import { describe, expect, it } from "bun:test";
import { getThemeByName } from "../../src/modes/theme/theme";
import { renderCodeCell } from "../../src/tui/code-cell";

describe("renderCodeCell", () => {
	it("renders running status, truncated code, and truncated output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const lines = renderCodeCell(
			{
				code: "const a = 1;\nconst b = 2;\nconst c = 3;",
				language: "ts",
				title: "Snippet",
				status: "running",
				spinnerFrame: 0,
				output: "one\ntwo\nthree",
				codeMaxLines: 1,
				outputMaxLines: 1,
				width: 80,
			},
			theme!,
		);
		const output = lines.join("\n");

		expect(output).toContain("running");
		expect(output).toContain("Snippet");
		expect(output).toContain("Output");
		expect(output).toContain("more lines");
	});

	it("renders the default title and preserves ANSI output lines", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const lines = renderCodeCell(
			{
				code: "echo ok",
				status: "pending",
				output: "\x1b[31mred\x1b[0m",
				width: 80,
			},
			theme!,
		);
		const output = lines.join("\n");

		expect(output).toContain("pending");
		expect(output).toContain("\x1b[31mred\x1b[0m");

		const defaultTitleLines = renderCodeCell({ code: "echo ok", width: 80 }, theme!);
		expect(defaultTitleLines.join("\n")).toContain("Code");
	});

	it("maps settled statuses and includes cell ordinal and duration metadata", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const complete = Bun.stripANSI(
			renderCodeCell(
				{
					code: "print('done')",
					title: "Notebook",
					status: "complete",
					index: 1,
					total: 3,
					duration: 1250,
					width: 80,
				},
				theme!,
			).join("\n"),
		);
		const warning = Bun.stripANSI(
			renderCodeCell({ code: "warn()", status: "warning", width: 80 }, theme!).join("\n"),
		);
		const error = Bun.stripANSI(renderCodeCell({ code: "raise()", status: "error", width: 80 }, theme!).join("\n"));

		expect(complete).toContain("[2/3]");
		expect(complete).toContain("Notebook");
		expect(complete).toContain("1.3s");
		expect(warning).toContain("warn()");
		expect(error).toContain("raise()");
	});
});
