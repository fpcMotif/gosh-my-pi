import { beforeAll, describe, expect, it } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import { getThemeByName } from "../../src/modes/theme/theme";
import type { Theme } from "../../src/modes/theme/theme";
import { formatArgsInline, formatScalar, renderJsonTreeLines } from "../../src/tools/json-tree";

let uiTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Failed to load dark theme for tests");
	uiTheme = loaded;
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderPlain(
	value: unknown,
	maxDepth = 6,
	maxLines = 200,
	maxScalarLen = 200,
): { text: string; truncated: boolean } {
	const rendered = renderJsonTreeLines(value, uiTheme, maxDepth, maxLines, maxScalarLen);
	return {
		text: stripAnsi(rendered.lines.join("\n")),
		truncated: rendered.truncated,
	};
}

describe("formatScalar", () => {
	it("renders JSON-like scalar labels and compact container summaries", () => {
		expect(formatScalar(null, 80)).toBe("null");
		expect(formatScalar(undefined, 80)).toBe("undefined");
		expect(formatScalar(true, 80)).toBe("true");
		expect(formatScalar(42, 80)).toBe("42");
		expect(formatScalar(["a", "b"], 80)).toBe("[2 items]");
		expect(formatScalar({ a: 1, b: 2 }, 80)).toBe("{2 keys}");
		expect(formatScalar(10n, 80)).toBe("10");
	});

	it("escapes newlines and tabs before truncating string values", () => {
		const formatted = formatScalar("alpha\nbeta\tgamma", 14);

		expect(formatted).toStartWith('"alpha\\nbeta');
		expect(formatted).toEndWith('"');
		expect(formatted).not.toContain("\n");
		expect(formatted).not.toContain("\t");
	});
});

describe("formatArgsInline", () => {
	it("omits hidden tool metadata fields from compact argument previews", () => {
		const rendered = formatArgsInline(
			{
				query: "docs",
				[INTENT_FIELD]: "hidden intent",
				__partialJson: "hidden partial",
				count: 2,
			},
			80,
		);

		expect(rendered).toBe('query="docs", count=2');
	});

	it("adds an ellipsis or truncates the current pair when the inline preview exceeds its budget", () => {
		expect(formatArgsInline({ first: "one", second: "two" }, 8)).toBe("first=…");
		expect(formatArgsInline({ a: 1, b: 2 }, 6)).toBe("a=1…");

		const truncatedPair = formatArgsInline({ longKey: "abcdefghijklmnopqrstuvwxyz" }, 18);
		expect(truncatedPair).toStartWith("longKey=");
		expect(truncatedPair.length).toBeLessThan('longKey="abcdefghijklmnopqrstuvwxyz"'.length);
	});
});

describe("renderJsonTreeLines", () => {
	it("renders root scalars with a value label", () => {
		const rendered = renderPlain("hello");

		expect(rendered.text).toContain('value: "hello"');
		expect(rendered.truncated).toBe(false);
	});

	it("renders root arrays, empty arrays, and empty objects with structural markers", () => {
		const array = renderPlain([1, [], {}]);

		expect(array.text).toContain("[0]: 1");
		expect(array.text).toContain("[]");
		expect(array.text).toContain("{}");
		expect(array.truncated).toBe(false);
	});

	it("renders nested arrays through completion", () => {
		const rendered = renderPlain({ items: [1, 2] });

		expect(rendered.text).toContain("items");
		expect(rendered.text).toContain("[0]: 1");
		expect(rendered.text).toContain("[1]: 2");
		expect(rendered.truncated).toBe(false);
	});

	it("marks truncation when maxLines is exhausted before or during container rendering", () => {
		expect(renderPlain("hidden", 6, 0).truncated).toBe(true);

		const emptyArray = renderPlain({ items: [] }, 6, 1);
		expect(emptyArray.text).toContain("items");
		expect(emptyArray.text).not.toContain("[]");
		expect(emptyArray.truncated).toBe(true);

		const rootArray = renderPlain([1, 2, 3], 6, 2);
		expect(rootArray.text).toContain("[0]: 1");
		expect(rootArray.text).toContain("[1]: 2");
		expect(rootArray.text).not.toContain("[2]: 3");
		expect(rootArray.truncated).toBe(true);

		const nestedArray = renderPlain({ items: [1, 2, 3] }, 6, 3);
		expect(nestedArray.text).toContain("[1]: 2");
		expect(nestedArray.text).not.toContain("[2]: 3");
		expect(nestedArray.truncated).toBe(true);

		const nestedObject = renderPlain({ obj: { a: 1, b: 2, c: 3 } }, 6, 3);
		expect(nestedObject.text).toContain("b: 2");
		expect(nestedObject.text).not.toContain("c: 3");
		expect(nestedObject.truncated).toBe(true);
	});

	it("hides internal metadata keys at the root while rendering ordinary object entries", () => {
		const rendered = renderPlain({
			visible: { child: "ok" },
			[INTENT_FIELD]: "hidden intent",
			__partialJson: "hidden partial",
		});

		expect(rendered.text).toContain("visible");
		expect(rendered.text).toContain('child: "ok"');
		expect(rendered.text).not.toContain("hidden intent");
		expect(rendered.text).not.toContain("hidden partial");
	});

	it("marks depth truncation with an ellipsis instead of expanding deeper values", () => {
		const rendered = renderPlain({ a: { b: { c: "deep" } } }, 1);

		expect(rendered.text).toContain("a");
		expect(rendered.text).toContain("…");
		expect(rendered.text).not.toContain("deep");
		expect(rendered.truncated).toBe(false);
	});

	it("marks array depth truncation with an ellipsis", () => {
		const rendered = renderPlain({ items: [[1]] }, 1);

		expect(rendered.text).toContain("items");
		expect(rendered.text).toContain("…");
		expect(rendered.text).not.toContain("[0]: 1");
		expect(rendered.truncated).toBe(false);
	});

	it("marks line truncation when the rendered tree exceeds maxLines", () => {
		const rendered = renderPlain({ a: 1, b: 2, c: 3 }, 6, 2);

		expect(rendered.text).toContain("a: 1");
		expect(rendered.text).toContain("b: 2");
		expect(rendered.text).not.toContain("c: 3");
		expect(rendered.truncated).toBe(true);
	});

	it("renders multiline strings with closing quotes when complete", () => {
		const rendered = renderPlain({ message: "first\nsecond" });

		expect(rendered.text).toContain('message: "first');
		expect(rendered.text).toContain(' second"');
		expect(rendered.truncated).toBe(false);
	});

	it("renders multiline string truncation as a counted continuation", () => {
		const rendered = renderPlain({ message: "first\nsecond\nthird\nfourth" }, 6, 3);

		expect(rendered.text).toContain('message: "first');
		expect(rendered.text).toContain("second");
		expect(rendered.text).toContain("more lines");
		expect(rendered.text).not.toContain("fourth");
		expect(rendered.truncated).toBe(true);
	});
});
