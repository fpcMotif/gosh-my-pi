import { describe, expect, it } from "bun:test";
import { gradientText } from "@oh-my-pi/pi-coding-agent/modes/components/gradient-text";

describe("gradientText", () => {
	it("emits per-character truecolor escapes when forced to truecolor", () => {
		const result = gradientText("AB", { fromHex: "#ff0000", toHex: "#0000ff", force: "truecolor" });
		// Each non-whitespace char gets its own \x1b[38;2;R;G;Bm prefix.
		const escapes = result.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g) ?? [];
		expect(escapes.length).toBe(2);
		// First char interpolates at t=0 → red (255,0,0). Last char at t=1 → blue (0,0,255).
		expect(escapes[0]).toBe("\x1b[38;2;255;0;0m");
		expect(escapes[1]).toBe("\x1b[38;2;0;0;255m");
		expect(result.endsWith("\x1b[39m")).toBe(true);
	});

	it("preserves whitespace without color codes", () => {
		const result = gradientText("A B", { fromHex: "#ff0000", toHex: "#0000ff", force: "truecolor" });
		// The middle space should appear as-is, not preceded by a color escape.
		expect(result).toContain(" ");
		const beforeSpace = result.indexOf(" ");
		// The character immediately before the space is the closing 'm' of an ANSI code (the colored 'A').
		// The character immediately after is the next color escape's '\x1b' (for 'B').
		expect(result[beforeSpace - 1]).toMatch(/[A-Z]/);
	});

	it("uses 256-color stepped palette when forced to 256color", () => {
		const result = gradientText("ABCDEF", { force: "256color" });
		const escapes = result.match(/\x1b\[38;5;(\d+)m/g) ?? [];
		// Stepped palette default has 6 entries; for 6 chars step=1 so we walk through them.
		expect(escapes.length).toBeGreaterThanOrEqual(2);
		// All escapes should be 256-color form, not truecolor.
		expect(result).not.toMatch(/\x1b\[38;2;/);
	});

	it("returns empty string for empty input", () => {
		expect(gradientText("", { force: "truecolor" })).toBe("");
	});
});
