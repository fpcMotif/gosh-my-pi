import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getAvailableThemes, getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("pi-vivid default theme", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	it("uses the pi-vivid theme and slash separator as defaults", () => {
		expect(settings.get("theme.dark")).toBe("pi-vivid");
		expect(settings.get("statusLine.preset")).toBe("pi-vivid");
		expect(settings.get("statusLine.separator")).toBe("slash");
	});

	it("registers the pi-vivid theme as a loadable built-in with vivid layout", async () => {
		const availableThemes = await getAvailableThemes();
		expect(availableThemes).toContain("pi-vivid");

		const piVividTheme = await getThemeByName("pi-vivid");
		expect(piVividTheme).toBeDefined();
		expect(piVividTheme?.getSymbolPreset()).toBe("unicode");
		expect(piVividTheme?.layout).toBe("vivid");
	});
});
