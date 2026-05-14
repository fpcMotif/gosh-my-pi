import { describe, expect, it } from "bun:test";
import { getSessionAccentAnsi, getSessionAccentHex, getSessionAccentHexForTitle } from "../src/utils/session-color";
import { formatSessionTerminalTitle } from "../src/utils/title-generator";

describe("getSessionAccentHexForTitle", () => {
	it("ignores auto-generated titles", () => {
		expect(getSessionAccentHexForTitle("Auto title", "auto")).toBeUndefined();
	});

	it("keeps explicit and legacy titles color-stable", () => {
		const expected = getSessionAccentHex("Named session");

		expect(getSessionAccentHexForTitle("Named session", "user")).toBe(expected);
		expect(getSessionAccentHexForTitle("Named session", undefined)).toBe(expected);
	});
});

describe("getSessionAccentAnsi", () => {
	it("maps absent colors to undefined and valid colors to ANSI 24-bit foreground escapes", () => {
		expect(getSessionAccentAnsi(undefined)).toBeUndefined();
		expect(getSessionAccentAnsi("")).toBeUndefined();
		expect(getSessionAccentAnsi("#ff0000")).toBe("\x1b[38;2;255;0;0m");
	});
});

describe("formatSessionTerminalTitle", () => {
	it("falls back to cwd when the session title was auto-generated", () => {
		expect(formatSessionTerminalTitle("Auto title", "/work/pi", "auto")).toBe("π: pi");
	});

	it("shows explicit session renames in the terminal title", () => {
		expect(formatSessionTerminalTitle("Manual title", "/work/pi", "user")).toBe("π: Manual title");
	});
});
