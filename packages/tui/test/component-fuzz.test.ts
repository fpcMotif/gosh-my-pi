/**
 * Property/fuzz coverage for core TUI primitives. Each property must hold
 * for every rendered line:
 *
 *  - visibleWidth(line) <= declared width
 *  - line never contains a raw \t (tabs must be replaced)
 *  - render() never throws on extreme widths (0/1/2/240) or random unicode
 */
import { describe, expect, it } from "bun:test";
import { Box, Markdown, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { defaultMarkdownTheme } from "./test-themes";

// Includes very small widths (0/1/2/3) to exercise the truncation floor —
// padded components must clamp content to fit even when the budget is
// smaller than `paddingX * 2 + 1`.
const SAMPLE_WIDTHS = [0, 1, 2, 3, 5, 10, 20, 40, 80, 120, 200, 240];

const GLYPHS = ["a", "Z", "0", "漢", "😀", " ", "_", "-", "\t", "é", "中"];

function rng(seed: number): { int(min: number, max: number): number; pick<T>(items: readonly T[]): T } {
	let s = seed % 2147483647;
	if (s <= 0) s += 2147483646;
	const next = () => {
		s = (s * 48271) % 2147483647;
		return s / 2147483647;
	};
	return {
		int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
		pick: items => items[Math.floor(next() * items.length)]!,
	};
}

function randomLine(r: ReturnType<typeof rng>, len: number): string {
	let out = "";
	for (let i = 0; i < len; i++) out += r.pick(GLYPHS);
	return out;
}

function expectBounded(lines: string[], width: number, label: string): void {
	for (const line of lines) {
		expect(line.includes("\t")).toBe(false);
		const w = visibleWidth(line);
		expect(w).toBeLessThanOrEqual(width);
	}
}

describe("Text component fuzz", () => {
	it("never exceeds declared width across random unicode and ANSI input", () => {
		const r = rng(0xc0ffee);
		for (let i = 0; i < 200; i++) {
			const width = SAMPLE_WIDTHS[i % SAMPLE_WIDTHS.length];
			const paddingX = r.int(0, 4);
			const text = new Text(randomLine(r, r.int(0, 200)), paddingX, r.int(0, 2));
			expectBounded(text.render(width), width, `Text[${i}] width=${width} pad=${paddingX}`);
		}
	});

	it("does not throw on extreme widths", () => {
		const text = new Text("hello\tworld\nsecond line\n漢字 emoji 😀", 1, 1);
		for (const w of [0, 1, 2, 3, 240]) {
			expect(() => text.render(w)).not.toThrow();
		}
	});
});

describe("Box component fuzz", () => {
	it("renders width-bounded chrome with mixed children", () => {
		const r = rng(0xfade);
		for (let i = 0; i < 100; i++) {
			const width = SAMPLE_WIDTHS[i % SAMPLE_WIDTHS.length];
			const box = new Box(r.int(0, 4), r.int(0, 2));
			const childCount = r.int(0, 4);
			for (let c = 0; c < childCount; c++) {
				box.addChild(new Text(randomLine(r, r.int(0, 60)), 0, 0));
			}
			expectBounded(box.render(width), width, `Box[${i}] width=${width}`);
		}
	});
});

describe("Markdown component fuzz", () => {
	it("renders width-bounded output for arbitrary markdown-shaped strings", () => {
		const r = rng(0xbabe);
		const blocks = [
			"# heading\n",
			"## subheading\n",
			"plain text with **bold** and _italic_ words\n",
			"- bullet 1\n- bullet 2\n",
			"```\ncode block\nline two\n```\n",
			"a [link](https://example.com) inline\n",
			"text with a tab\there and there\n",
		];
		for (let i = 0; i < 60; i++) {
			const width = Math.max(10, SAMPLE_WIDTHS[i % SAMPLE_WIDTHS.length]);
			const text = Array.from({ length: r.int(1, 5) }, () => r.pick(blocks)).join("\n");
			const md = new Markdown(text, 1, 0, defaultMarkdownTheme);
			expectBounded(md.render(width), width, `Markdown[${i}] width=${width}`);
		}
	});

	it("setText invalidates cache deterministically", () => {
		const md = new Markdown("first", 0, 0, defaultMarkdownTheme);
		const a = md.render(40).join("\n");
		md.setText("second");
		const b = md.render(40).join("\n");
		expect(b).not.toBe(a);
	});
});
