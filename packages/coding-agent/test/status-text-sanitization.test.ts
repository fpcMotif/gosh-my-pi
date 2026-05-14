import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { getTabBarTheme, sanitizeStatusText } from "../src/modes/shared";

beforeAll(async () => {
	await initTheme(false);
});

describe("sanitizeStatusText", () => {
	it("strips OSC, DCS, PM, APC, and 8-bit CSI escape sequences", () => {
		const input =
			"prefix " +
			"\x1b]8;;https://example.com\x07link\x1b]8;;\x07" +
			" " +
			"\x1bPhidden-dcs\x1b\\" +
			"\x1b^hidden-pm\x1b\\" +
			"\x1b_hidden-apc\x1b\\" +
			"\x9b31mred\x9b0m" +
			" suffix";

		expect(sanitizeStatusText(input)).toBe("prefix link red suffix");
	});
});

describe("getTabBarTheme", () => {
	it("provides render functions for active, inactive, and hint tab states", () => {
		const tabTheme = getTabBarTheme();

		expect(Bun.stripANSI(tabTheme.label("Models"))).toBe("Models");
		expect(Bun.stripANSI(tabTheme.activeTab("Active"))).toBe("Active");
		expect(Bun.stripANSI(tabTheme.inactiveTab("Other"))).toBe("Other");
		expect(Bun.stripANSI(tabTheme.hint("Ctrl+N"))).toBe("Ctrl+N");
	});
});
