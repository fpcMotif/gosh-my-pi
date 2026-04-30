import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderOutputBlock, renderStatusLine } from "@oh-my-pi/pi-coding-agent/tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";

async function getUiTheme() {
	const uiTheme = await getThemeByName("pi-vivid");
	expect(uiTheme).toBeDefined();
	return uiTheme!;
}

describe("tool card chrome", () => {
	it("adds truthful default status badges to tool headers", async () => {
		const uiTheme = await getUiTheme();
		const pending = Bun.stripANSI(renderStatusLine({ icon: "pending", title: "Read" }, uiTheme));
		const success = Bun.stripANSI(renderStatusLine({ icon: "success", title: "Read" }, uiTheme));
		const error = Bun.stripANSI(renderStatusLine({ icon: "error", title: "Read" }, uiTheme));

		expect(pending).toContain("Read");
		expect(pending).toContain("pending");
		expect(success).toContain("done");
		expect(error).toContain("error");
	});

	it("renders rounded width-safe output blocks with sanitized tabs", async () => {
		const uiTheme = await getUiTheme();
		const lines = renderOutputBlock(
			{
				header: "Bash",
				headerMeta: "running",
				state: "running",
				sections: [{ label: "Output", lines: ["alpha\tbeta"] }],
				width: 40,
			},
			uiTheme,
		);
		const rendered = Bun.stripANSI(lines.join("\n"));

		expect(rendered).toContain("╭");
		expect(rendered).toContain("╯");
		expect(rendered).toContain("alpha   beta");
		expect(rendered).not.toContain("\t");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
