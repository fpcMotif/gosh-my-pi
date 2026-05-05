import { beforeAll, describe, expect, it } from "bun:test";
import { renderDiff } from "../../../src/modes/components/diff";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme not found");
	setThemeInstance(theme);
});

/**
 * Contract: renderDiff produces diff text where the line-number gutter
 * width never exceeds a sensible upper bound, regardless of input.
 * Currently `lineNumberWidth = max(...parsed.lineNum.length)` is unbounded —
 * a million-line diff (lineNum ≥ 7 chars) eats column real-estate on narrow
 * terminals; a 12-digit line number eats it entirely.
 *
 * Tests inspect the rendered output's gutter widths after stripping ANSI
 * codes. The diff.ts internals use formatCodeFrameLine which produces
 * `<padded-gutter>│<content>` per non-context line.
 */

// Strip ANSI SGR sequences and DIM markers so we can measure visible width.
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function gutterWidthsFor(rendered: string): number[] {
	return stripAnsi(rendered)
		.split("\n")
		.filter(line => line.includes("│"))
		.map(line => line.indexOf("│"));
}

describe("renderDiff — line-number gutter bounds", () => {
	it("renders a small diff with a tight gutter (1-digit line numbers)", () => {
		const diff = "-1|old line\n+1|new line";
		const rendered = renderDiff(diff);
		const widths = gutterWidthsFor(rendered);
		expect(widths.length).toBeGreaterThan(0);
		// Gutter is `<sign><lineNum>` padded to (lineNumberWidth + 1) followed by `│`.
		// For "1" (1 char), padded width is 2, so gutter columns ≤ 3.
		for (const width of widths) {
			expect(width).toBeLessThanOrEqual(3);
		}
	});

	it("scales the gutter to a 6-digit line number without exploding", () => {
		// Six-digit line numbers (up to 999,999) are realistic for large repos.
		const diff = "-999999|old\n+999999|new";
		const rendered = renderDiff(diff);
		const widths = gutterWidthsFor(rendered);
		expect(widths.length).toBeGreaterThan(0);
		// Realistic upper bound: sign(1) + 6 digits + padding(1) = 8.
		for (const width of widths) {
			expect(width).toBeLessThanOrEqual(8);
		}
	});

	it("does not let a 13-digit line number monopolise the gutter", () => {
		// Pathological input: a producer accidentally puts a hash or huge index
		// where the line number should be. Without a clamp, lineNumberWidth = 13
		// and the gutter alone is 14+ chars before any content - pushes content
		// off-screen on standard terminals. Contract: gutter clamped at 8
		// (room for ≤ 7-digit line numbers covers all realistic source files
		// up to ten million lines; longer numbers truncate gracefully).
		const diff = "-1234567890123|old\n+1234567890123|new";
		const rendered = renderDiff(diff);
		const widths = gutterWidthsFor(rendered);
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			expect(width).toBeLessThanOrEqual(8);
		}
	});

	it("uses a consistent gutter width across mixed-magnitude line numbers in one hunk", () => {
		const diff = "-1|small\n-1234567|large\n+1234567|large\n+1|small";
		const rendered = renderDiff(diff);
		const widths = gutterWidthsFor(rendered);
		expect(widths.length).toBeGreaterThan(0);
		// All gutters in a hunk share the same width (driven by the max line number).
		const distinctWidths = new Set(widths);
		expect(distinctWidths.size).toBe(1);
	});

	it("renders an empty diff string without crashing", () => {
		expect(() => renderDiff("")).not.toThrow();
		const rendered = renderDiff("");
		// Empty input produces empty output (or one blank line) — no panic, no widget.
		expect(stripAnsi(rendered).trim()).toBe("");
	});
});
