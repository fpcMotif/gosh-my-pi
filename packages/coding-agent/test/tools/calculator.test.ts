import { describe, expect, it } from "bun:test";
import { fromAny } from "@total-typescript/shoehorn";
import { getThemeByName, type Theme } from "../../src/modes/theme/theme";
import { CalculatorTool, calculatorToolRenderer } from "../../src/tools/calculator";
import type { ToolSession } from "../../src/tools/index";

function createTool(): CalculatorTool {
	return new CalculatorTool(fromAny<ToolSession>({}));
}

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

describe("CalculatorTool", () => {
	it("evaluates supported arithmetic syntax and formats prefixed outputs", async () => {
		const tool = createTool();

		const result = await tool.execute("call-calc", {
			calculations: [
				{ expression: "2 + 3 * 4", prefix: "", suffix: "" },
				{ expression: "(2 + 3) * 4", prefix: "grouped=", suffix: "!" },
				{ expression: "2 ** 3 ** 2", prefix: "pow:", suffix: "" },
				{ expression: "0x10 + 0b11 + 0o7 + 1e2 + .5", prefix: "", suffix: " total" },
				{ expression: "--5", prefix: "unary ", suffix: "" },
				{ expression: "0 * -1", prefix: "zero ", suffix: "" },
			],
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: ["14", "grouped=20!", "pow:512", "126.5 total", "unary 5", "zero 0"].join("\n"),
			},
		]);
		expect(result.details).toEqual({
			results: [
				{ expression: "2 + 3 * 4", value: 14, output: "14" },
				{ expression: "(2 + 3) * 4", value: 20, output: "grouped=20!" },
				{ expression: "2 ** 3 ** 2", value: 512, output: "pow:512" },
				{ expression: "0x10 + 0b11 + 0o7 + 1e2 + .5", value: 126.5, output: "126.5 total" },
				{ expression: "--5", value: 5, output: "unary 5" },
				{ expression: "0 * -1", value: 0, output: "zero 0" },
			],
		});
	});

	it("surfaces expression parse and finite-number failures", async () => {
		const tool = createTool();
		const cases = [
			["", "Expression is empty"],
			["2 / 0", "Expression result is not a finite number"],
			["0x + 1", "Invalid numeric literal"],
			["1e + 2", "Invalid exponent"],
			["(1 + 2", "Missing closing parenthesis"],
			["1 2", "Unexpected token in expression"],
			["foo", 'Invalid character "f" in expression'],
		] as const;

		for (const [expression, message] of cases) {
			await expect(
				tool.execute("call-invalid", {
					calculations: [{ expression, prefix: "", suffix: "" }],
				}),
			).rejects.toThrow(message);
		}
	});

	it("honors an already-aborted signal before returning calculation output", async () => {
		const tool = createTool();
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool.execute(
				"call-aborted",
				{
					calculations: [{ expression: "2 + 2", prefix: "", suffix: "" }],
				},
				controller.signal,
			),
		).rejects.toThrow();
	});
});

describe("calculatorToolRenderer", () => {
	it("renders call previews with the first expression and calculation count", async () => {
		const theme = await loadTheme();
		const rendered = calculatorToolRenderer.renderCall(
			{
				calculations: [
					{ expression: "2 + 2", prefix: "", suffix: "" },
					{ expression: "4 * 4", prefix: "", suffix: "" },
				],
			},
			{ expanded: false, isPartial: true },
			theme,
		);

		const text = renderPlainText(rendered);
		expect(text).toContain("Calc");
		expect(text).toContain("2 + 2");
		expect(text).toContain("2 calcs");
	});

	it("renders errors and empty successful results with status-specific messages", async () => {
		const theme = await loadTheme();
		const errorText = renderPlainText(
			calculatorToolRenderer.renderResult(
				{ content: [{ type: "text", text: "Invalid expression" }], isError: true },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(errorText).toContain("Calc");
		expect(errorText).toContain("Invalid expression");

		const emptyText = renderPlainText(
			calculatorToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }] },
				{ expanded: false, isPartial: false },
				theme,
			),
		);
		expect(emptyText).toContain("Calc");
		expect(emptyText).toContain("No results");
	});

	it("prefers structured results and invalidates cached tree output", async () => {
		const theme = await loadTheme();
		const rendered = calculatorToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "ignored fallback" }],
				details: {
					results: [
						{ expression: "2 + 2", value: 4, output: "4" },
						{ expression: "3 * 3", value: 9, output: "9" },
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ calculations: [{ expression: "2 + 2", prefix: "", suffix: "" }] },
		);

		const firstRender = renderPlainText(rendered);
		rendered.invalidate();
		const secondRender = renderPlainText(rendered);

		expect(firstRender).toContain("Calc");
		expect(firstRender).toContain("2 + 2");
		expect(firstRender).toContain("2 results");
		expect(firstRender).toContain("2 + 2 = 4");
		expect(firstRender).toContain("3 * 3 = 9");
		expect(firstRender).not.toContain("ignored fallback");
		expect(secondRender).toBe(firstRender);
	});

	it("pairs fallback text output with streamed call expressions when details are absent", async () => {
		const theme = await loadTheme();
		const rendered = calculatorToolRenderer.renderResult(
			{ content: [{ type: "text", text: "4\n9" }] },
			{ expanded: true, isPartial: false },
			theme,
			{
				calculations: [
					{ expression: "2 + 2", prefix: "", suffix: "" },
					{ expression: "3 * 3", prefix: "", suffix: "" },
				],
			},
		);

		const text = renderPlainText(rendered);
		expect(text).toContain("2 + 2 = 4");
		expect(text).toContain("3 * 3 = 9");
	});

	it("renders raw fallback output when expression count does not match text lines", async () => {
		const theme = await loadTheme();
		const rendered = calculatorToolRenderer.renderResult(
			{ content: [{ type: "text", text: "4\nextra" }] },
			{ expanded: true, isPartial: false },
			theme,
			{ calculations: [{ expression: "2 + 2", prefix: "", suffix: "" }] },
		);

		const text = renderPlainText(rendered);
		expect(text).toContain("4");
		expect(text).toContain("extra");
		expect(text).not.toContain("2 + 2 = 4");
	});
});
