import { beforeAll, describe, expect, it } from "bun:test";
import { renderMCPCall, renderMCPResult } from "../src/mcp/render";
import { getThemeByName } from "../src/modes/theme/theme";
import type { Theme } from "../src/modes/theme/theme";

let uiTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Failed to load dark theme for tests");
	uiTheme = loaded;
});

function renderedText(component: { render(width: number): string[] }, width = 200): string {
	return component
		.render(width)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderMCPCall", () => {
	it("renders pending tool labels with a compact argument preview", () => {
		const rendered = renderedText(renderMCPCall({ query: "semantic code search", count: 2 }, uiTheme, "MCP Search"));

		expect(rendered).toContain("MCP Search");
		expect(rendered).toContain('query="semantic code search"');
		expect(rendered).toContain("count=2");
	});

	it("omits the argument preview when there are no visible arguments", () => {
		const rendered = renderedText(renderMCPCall({}, uiTheme, "MCP Ping"));

		expect(rendered).toContain("MCP Ping");
		expect(rendered).not.toContain("└");
	});
});

describe("renderMCPResult", () => {
	it("renders expanded arguments before the text output", () => {
		const rendered = renderedText(
			renderMCPResult({ content: [{ type: "text", text: "done" }] }, { expanded: true, isPartial: false }, uiTheme, {
				path: "src/index.ts",
				recursive: false,
			}),
		);

		expect(rendered).toContain("Args");
		expect(rendered).toContain('path: "src/index.ts"');
		expect(rendered).toContain("recursive: false");
		expect(rendered).toContain("done");
	});

	it("marks expanded arguments when the rendered argument tree is line-truncated", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: "ready" }] },
				{ expanded: true, isPartial: false },
				uiTheme,
				{ items: Array.from({ length: 220 }, (_, index) => index) },
			),
		);

		expect(rendered).toContain("Args");
		expect(rendered).toContain("[198]: 198");
		expect(rendered).toContain("…");
		expect(rendered).toContain("ready");
		expect(rendered).not.toContain("[199]: 199");
	});

	it("renders a no-output marker when the selected text content is empty", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: "   \n" }] },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("(no output)");
	});

	it("renders collapsed JSON output as a structured tree with an expand hint", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: JSON.stringify({ status: "ok", count: 3 }) }] },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain('status: "ok"');
		expect(rendered).toContain("count: 3");
		expect(rendered).toContain("Ctrl+O for more");
	});

	it("marks expanded JSON output when the rendered tree is line-truncated", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: JSON.stringify(Array.from({ length: 220 }, (_, index) => index)) }] },
				{ expanded: true, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("[0]: 0");
		expect(rendered).toContain("[199]: 199");
		expect(rendered).toContain("…");
		expect(rendered).not.toContain("Ctrl+O for more");
		expect(rendered).not.toContain("[219]: 219");
	});

	it("falls back to raw text when JSON-shaped output cannot be parsed", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: "{not json}" }] },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("{not json}");
		expect(rendered).toContain("Ctrl+O for more");
	});

	it("bounds raw collapsed output and reports the hidden line count", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: ["one", "two", "three", "four", "five", "six"].join("\n") }] },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("one");
		expect(rendered).toContain("four");
		expect(rendered).toContain("… 2 more lines");
		expect(rendered).toContain("Ctrl+O for more");
		expect(rendered).not.toContain("six");
	});

	it("bounds raw expanded output without showing a collapsed expand hint", () => {
		const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: lines.join("\n") }] },
				{ expanded: true, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("line 1");
		expect(rendered).toContain("line 12");
		expect(rendered).toContain("… 2 more lines");
		expect(rendered).not.toContain("Ctrl+O for more");
		expect(rendered).not.toContain("line 14");
	});

	it("still shows the collapsed expand hint when all raw preview lines fit", () => {
		const rendered = renderedText(
			renderMCPResult(
				{ content: [{ type: "text", text: "short output" }] },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("short output");
		expect(rendered).toContain("Ctrl+O for more");
	});
});
