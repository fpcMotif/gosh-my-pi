import { describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "../../../src/modes/theme/theme";
import { renderSearchCall, renderSearchResult, webSearchToolRenderer } from "../../../src/web/search/render";
import type { SearchResponse } from "../../../src/web/search/types";

async function loadTheme(): Promise<Theme> {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Expected dark theme to load");
	}
	return theme;
}

function renderPlainText(component: { render(width: number): string[] }, width = 120): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("web search renderer", () => {
	it("renders call previews and exposes mergeable tool renderer hooks", async () => {
		const theme = await loadTheme();
		const rendered = renderSearchCall(
			{ query: "latest bun release notes" },
			{ expanded: false, isPartial: true },
			theme,
		);

		expect(renderPlainText(rendered)).toContain("Web Search");
		expect(renderPlainText(rendered)).toContain("latest bun release notes");
		expect(webSearchToolRenderer.renderCall).toBe(renderSearchCall);
		expect(webSearchToolRenderer.renderResult).toBe(renderSearchResult);
		expect(webSearchToolRenderer.mergeCallAndResult).toBe(true);
	});

	it("renders provider errors without falling back to raw content", async () => {
		const theme = await loadTheme();
		const rendered = renderSearchResult(
			{
				content: [{ type: "text", text: "raw fallback" }],
				details: {
					error: "provider unavailable",
					response: {
						provider: "none",
						sources: [],
					},
				},
			},
			{ expanded: false, isPartial: false },
			theme,
		);

		const text = renderPlainText(rendered);
		expect(text).toContain("Error: provider unavailable");
		expect(text).not.toContain("raw fallback");
	});

	it("renders fallback text when structured response details are absent", async () => {
		const theme = await loadTheme();
		const rawText = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
		const collapsed = renderSearchResult(
			{ content: [{ type: "text", text: rawText }] },
			{ expanded: false, isPartial: false },
			theme,
		);
		const expanded = renderSearchResult(
			{ content: [{ type: "text", text: rawText }] },
			{ expanded: true, isPartial: false },
			theme,
		);
		const empty = renderSearchResult(
			{ content: [{ type: "text", text: "  \n\t" }] },
			{ expanded: false, isPartial: false },
			theme,
		);

		const collapsedText = renderPlainText(collapsed);
		expect(collapsedText).toContain("Response");
		expect(collapsedText).toContain("line 6");
		expect(collapsedText).not.toContain("line 7");
		expect(collapsedText).toContain("2 more lines");
		expect(renderPlainText(expanded)).toContain("line 8");
		expect(renderPlainText(empty)).toContain("No response data");
	});

	it("renders structured answers, sources, metadata, and collapsed source overflow", async () => {
		const theme = await loadTheme();
		const response: SearchResponse = {
			provider: "kimi",
			answer: "First answer line\nSecond answer line\nThird answer line\nFourth answer line",
			sources: [
				{
					title: "Primary Source",
					url: "https://www.example.com/docs",
					snippet: "Snippet first line\nSnippet second line\nSnippet third line",
					author: "Example Author",
					publishedDate: "2026-05-01",
				},
				{ title: "", url: "https://fallback.example.com/path", snippet: "" },
				...Array.from({ length: 7 }, (_, index) => ({
					title: `Extra Source ${index + 1}`,
					url: `https://extra.example.com/${index + 1}`,
				})),
			],
			citations: [{ title: "Citation", url: "https://citation.example.com", citedText: "quoted" }],
			searchQueries: ["first query", "second query", "third query"],
			usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, searchRequests: 2 },
			model: "moonshot-web",
			requestId: "request-id-with-a-very-long-value-that-gets-truncated",
			authMode: "oauth",
		};

		const rendered = renderSearchResult(
			{ content: [{ type: "text", text: "raw fallback" }], details: { response } },
			{ expanded: false, isPartial: false },
			theme,
			{ query: "explicit rendered query" },
		);
		const text = renderPlainText(rendered);

		expect(text).toContain("Web Search");
		expect(text).toContain("Kimi");
		expect(text).toContain("explicit rendered query");
		expect(text).toContain("First answer line");
		expect(text).toContain("1 more line");
		expect(text).toContain("Primary Source");
		expect(text).toContain("(example.com)");
		expect(text).toContain("Example Author");
		expect(text).toContain("2026-05-01");
		expect(text).toContain("https://www.example.com/docs");
		expect(text).toContain("https://fallback.example.com/path");
		expect(text).toContain("1 more source");
		expect(text).toContain("Provider:");
		expect(text).toContain("Auth:");
		expect(text).toContain("OAuth");
		expect(text).toContain("Model:");
		expect(text).toContain("moonshot-web");
		expect(text).toContain("Citations:");
		expect(text).toContain("Usage:");
		expect(text).toContain("in 10");
		expect(text).toContain("out 20");
		expect(text).toContain("total 30");
		expect(text).toContain("search 2");
		expect(text).toContain("Request:");
		expect(text).toContain("Queries:");
		expect(text).toContain("first query; second query");
		expect(text).not.toContain("third query");
		expect(text).not.toContain("raw fallback");

		rendered.invalidate();
		expect(renderPlainText(rendered)).toContain("Primary Source");
	});

	it("renders empty structured responses with warning copy and no query section", async () => {
		const theme = await loadTheme();
		const response: SearchResponse = {
			provider: "none",
			sources: [],
			authMode: "api_key",
		};

		const rendered = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details: { response } },
			{ expanded: true, isPartial: false },
			theme,
		);
		const text = renderPlainText(rendered);

		expect(text).toContain("Web Search");
		expect(text).toContain("None");
		expect(text).toContain("No answer text returned");
		expect(text).toContain("No sources returned");
		expect(text).toContain("API key");
		expect(text).not.toContain("Query:");
	});

	it("honors long-answer rendering limits without truncating source details", async () => {
		const theme = await loadTheme();
		const response: SearchResponse = {
			provider: "zai",
			answer: `${"alpha beta gamma ".repeat(20)}\nsecond long line\nthird long line`,
			sources: [{ title: "Z source", url: "https://z.example.com", snippet: "Z snippet" }],
			searchQueries: ["fallback query"],
		};

		const rendered = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details: { response } },
			{ expanded: true, isPartial: false },
			theme,
			{ allowLongAnswer: true, maxAnswerLines: 2 },
		);
		const text = renderPlainText(rendered, 80);

		expect(text).toContain("Z.AI");
		expect(text).toContain("alpha beta gamma");
		expect(text).toContain("second long line");
		expect(text).not.toContain("third long line");
		expect(text).toContain("1 more line");
		expect(text).toContain("fallback query");
		expect(text).toContain("Z source");
	});
});
