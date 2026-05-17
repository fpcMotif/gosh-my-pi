import { afterEach, describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CachedOutputBlock, renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;

describe("renderOutputBlock", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
	});

	it("passes SIXEL lines through without trimming or padding", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const sixel = "\x1bPqabc\x1b\\";
		const lines = renderOutputBlock(
			{
				width: 40,
				sections: [{ label: "Output", lines: ["regular line", sixel] }],
			},
			uiTheme,
		);

		expect(lines.filter(line => line === sixel)).toHaveLength(1);
		const regularLine = lines.find(line => line.includes("regular line"));
		expect(regularLine).toBeDefined();
		expect(regularLine).not.toBe("regular line");
	});

	it("restores block background after SGR resets inside content", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const bgAnsi = uiTheme.getBgAnsi("toolPendingBg");

		const lines = renderOutputBlock(
			{
				width: 60,
				state: "running",
				sections: [{ lines: [`before\x1b[0mafter\x1b[49mdone`] }],
			},
			uiTheme,
		);
		const contentLine = lines.find(line => line.includes("before"));

		expect(contentLine).toBeDefined();
		expect(contentLine).toContain(`\x1b[0m${bgAnsi}`);
		expect(contentLine).toContain(`\x1b[49m${bgAnsi}`);
	});

	it("reuses cached block renders until explicitly invalidated", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const cache = new CachedOutputBlock();
		const options = { width: 40, header: "Run", sections: [{ lines: ["first"] }] };

		const first = cache.render(options, uiTheme);
		const cached = cache.render(options, uiTheme);
		expect(cached).toBe(first);

		cache.invalidate();
		const rebuilt = cache.render(options, uiTheme);
		expect(rebuilt).toEqual(first);
		expect(rebuilt).not.toBe(first);
	});
});
