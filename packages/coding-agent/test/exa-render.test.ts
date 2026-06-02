import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName } from "../src/modes/theme/theme";
import type { Theme } from "../src/modes/theme/theme";
import { renderExaCall, renderExaResult } from "../src/exa/render";
import type { ExaSearchResponse } from "../src/exa/types";

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

describe("renderExaResult", () => {
	it("renders errors without leaking duplicate Error prefixes", () => {
		const rendered = renderedText(
			renderExaResult(
				{
					content: [],
					details: { error: "Error: upstream unavailable", toolName: "exa_search" },
				},
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);

		expect(rendered).toContain("Error: upstream unavailable");
		expect(rendered).not.toContain("Error: Error:");
	});

	it("renders empty response state when no structured response or raw payload exists", () => {
		const rendered = renderedText(
			renderExaResult({ content: [], details: {} }, { expanded: false, isPartial: false }, uiTheme),
		);

		expect(rendered).toContain("No response data");
	});

	it("renders raw payload previews collapsed and full raw payloads expanded", () => {
		const raw = {
			first: "one",
			second: "two",
			third: "three",
			fourth: "four",
			fifth: "five",
		};

		const collapsed = renderedText(
			renderExaResult({ content: [], details: { raw } }, { expanded: false, isPartial: false }, uiTheme),
		);
		expect(collapsed).toContain("Raw response");
		expect(collapsed).toContain('"first": "one"');
		expect(collapsed).toContain("more lines");

		const expanded = renderedText(
			renderExaResult({ content: [], details: { raw } }, { expanded: true, isPartial: false }, uiTheme),
		);
		expect(expanded).toContain('"fifth": "five"');
		expect(expanded).not.toContain("more lines");
	});

	it("renders no-result responses in collapsed and expanded modes", () => {
		const response: ExaSearchResponse = { results: [], costDollars: { total: 0.01 }, searchTime: 0.25 };

		const collapsed = renderedText(
			renderExaResult({ content: [], details: { response } }, { expanded: false, isPartial: false }, uiTheme),
		);
		const expanded = renderedText(
			renderExaResult({ content: [], details: { response } }, { expanded: true, isPartial: false }, uiTheme),
		);

		expect(collapsed).toContain("0 results");
		expect(collapsed).toContain("cost:$0.0100");
		expect(collapsed).toContain("time:0.25s");
		expect(collapsed).toContain("No results");
		expect(expanded).toContain("No results");
	});

	it("collapses search results to the first preview plus remaining line and result counts", () => {
		const response: ExaSearchResponse = {
			results: [
				{
					title: "First result",
					text: ["line one", "line two", "line three", "line four", "line five"].join("\n"),
				},
				{ title: "Second result", text: "second" },
			],
		};

		const rendered = renderedText(
			renderExaResult({ content: [], details: { response } }, { expanded: false, isPartial: false }, uiTheme),
		);

		expect(rendered).toContain("2 results");
		expect(rendered).toContain("line one");
		expect(rendered).toContain("more lines");
		expect(rendered).toContain("more result");
		expect(rendered).not.toContain("Second result");
	});

	it("uses title fallback and muted placeholder when collapsed preview text is absent", () => {
		const titleOnly = renderedText(
			renderExaResult(
				{ content: [], details: { response: { results: [{ title: "Title fallback" }] } } },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);
		expect(titleOnly).toContain("Title fallback");

		const noPreview = renderedText(
			renderExaResult(
				{ content: [], details: { response: { results: [{}] } } },
				{ expanded: false, isPartial: false },
				uiTheme,
			),
		);
		expect(noPreview).toContain("No preview text");
	});

	it("expands result metadata, text previews, and bounded highlights", () => {
		const response: ExaSearchResponse = {
			results: [
				{
					title: "First expanded result",
					url: "https://example.com/docs/page",
					author: "Ada",
					publishedDate: "2026-05-14",
					text: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n"),
					highlights: ["one", "two", "three", "four"],
				},
				{
					url: "",
					text: "",
				},
			],
		};

		const rendered = renderedText(
			renderExaResult({ content: [], details: { response } }, { expanded: true, isPartial: false }, uiTheme),
		);

		expect(rendered).toContain("First expanded result");
		expect(rendered).toContain("(example.com)");
		expect(rendered).toContain("https://example.com/docs/page");
		expect(rendered).toContain("Author: Ada");
		expect(rendered).toContain("Published: 2026-05-14");
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("epsilon");
		expect(rendered).toContain("more line");
		expect(rendered).toContain("Highlights");
		expect(rendered).toContain("more highlight");
		expect(rendered).toContain("Untitled");
	});
});

describe("renderExaCall", () => {
	it("renders query previews with result counts and safe fallbacks", () => {
		const withQuery = renderedText(
			renderExaCall({ query: "semantic code search", num_results: 3 }, "Exa Search", uiTheme),
		);
		expect(withQuery).toContain("Exa Search semantic code search results:3");

		const fallback = renderedText(renderExaCall({}, "", uiTheme));
		expect(fallback).toContain("Exa Search ?");
	});
});
