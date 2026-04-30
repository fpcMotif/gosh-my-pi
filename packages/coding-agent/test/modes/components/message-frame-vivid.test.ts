import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MessageFrame } from "@oh-my-pi/pi-coding-agent/modes/components/message-frame";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("MessageFrame vivid layout", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	it("uses the thin rail (│) when not focused under vivid layout", () => {
		expect(theme.layout).toBe("vivid"); // default theme is pi-vivid
		const frame = new MessageFrame({ railColor: "borderRailUser", focused: false });
		frame.addChild(new Text("hello", 0, 0));
		const lines = frame.render(40);
		expect(lines.length).toBeGreaterThan(0);
		// Strip ANSI to inspect the raw glyph sequence.
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped.startsWith("│ ")).toBe(true);
	});

	it("switches to the thick rail (▌) when focused under vivid layout", () => {
		const frame = new MessageFrame({ railColor: "borderRailUser", focused: true });
		frame.addChild(new Text("hello", 0, 0));
		const lines = frame.render(40);
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped.startsWith("▌ ")).toBe(true);
	});

	it("setFocused toggles the rail glyph on subsequent renders", () => {
		const frame = new MessageFrame({ railColor: "borderRailUser" });
		frame.addChild(new Text("hello", 0, 0));
		const initial = frame.render(40)[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(initial.startsWith("│ ")).toBe(true);
		frame.setFocused(true);
		const focused = frame.render(40)[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(focused.startsWith("▌ ")).toBe(true);
	});

	it("suppresses inline label under vivid layout", () => {
		const frame = new MessageFrame({ railColor: "borderRailUser", label: "you", labelColor: "customMessageLabel" });
		frame.addChild(new Text("hello", 0, 0));
		const lines = frame.render(40);
		// Vivid suppresses the label entirely — content is just the message body.
		const allText = lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
		expect(allText).not.toContain("you");
		expect(allText).toContain("hello");
	});
});
