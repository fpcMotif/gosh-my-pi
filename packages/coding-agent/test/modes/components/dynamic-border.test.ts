import { describe, expect, it } from "bun:test";
import { DynamicBorder } from "../../../src/modes/components/dynamic-border";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

describe("DynamicBorder", () => {
	it("renders at least one border glyph through the default theme color", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);

		const border = new DynamicBorder();
		border.invalidate();
		const lines = border.render(0);

		expect(lines).toHaveLength(1);
		expect(Bun.stripANSI(lines[0]!)).toHaveLength(1);
		expect(lines[0]).not.toBe(Bun.stripANSI(lines[0]!));
	});
});
