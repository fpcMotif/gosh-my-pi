import { beforeAll, describe, expect, it } from "bun:test";
import { WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

function expectWidthBounded(lines: string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

beforeAll(async () => {
	await initTheme(false, "unicode", false, "pi-vivid", "light");
});

describe("welcome chrome", () => {
	it("renders the pi-vivid welcome surface with context sections", () => {
		const component = new WelcomeComponent(
			"1.2.3",
			"Claude Sonnet",
			"anthropic",
			[{ name: "session-alpha", timeAgo: "now" }],
			[{ name: "typescript", status: "ready", fileTypes: ["ts", "tsx"] }],
		);
		const lines = component.render(100);
		const rendered = Bun.stripANSI(lines.join("\n"));

		expect(rendered).toContain("OH MY PI");
		expect(rendered).toContain("vivid ui");
		expect(rendered).toContain("Shortcuts");
		expect(rendered).toContain("Language servers");
		expect(rendered).toContain("Recent work");
		expect(rendered).toContain("Claude Sonnet");
		expectWidthBounded(lines, 100);
	});

	it("stays width-safe on narrow terminals", () => {
		const component = new WelcomeComponent("1.2.3", "model", "provider");
		const lines = component.render(32);

		expect(lines.length).toBeGreaterThan(0);
		expectWidthBounded(lines, 32);
	});
});
