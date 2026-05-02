import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RowSplit } from "@oh-my-pi/pi-coding-agent/modes/components/row-split";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("RowSplit", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	it("renders the default separator while preserving total visible width", () => {
		const split = new RowSplit(new StaticLines(["left"]), new StaticLines(["right"]), { leftWidth: 5 });

		const lines = split.render(12);

		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toContain("│");
		expect(visibleWidth(lines[0])).toBe(12);
	});

	it("omits the separator when explicitly configured with an empty string", () => {
		const split = new RowSplit(new StaticLines(["left"]), new StaticLines(["right"]), {
			leftWidth: 5,
			separator: "",
		});

		const lines = split.render(12);

		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).not.toContain("│");
		expect(visibleWidth(lines[0])).toBe(12);
		expect(stripAnsi(lines[0])).toBe("left right  ");
	});

	it("keeps narrow renders width-bounded", () => {
		const split = new RowSplit(new StaticLines(["left-column"]), new StaticLines(["right-column"]), { leftWidth: 8 });

		for (const width of [0, 1, 2, 4]) {
			const lines = split.render(width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps ANSI-colored child output width-bounded", () => {
		const split = new RowSplit(new StaticLines(["\x1b[31mred\x1b[39m"]), new StaticLines(["right"]), {
			leftWidth: 6,
		});

		const lines = split.render(14);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("\x1b[31m");
		expect(visibleWidth(lines[0])).toBe(14);
	});
});
