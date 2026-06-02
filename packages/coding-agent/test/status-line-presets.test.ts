import { describe, expect, it } from "bun:test";
import { getPreset, STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";

describe("status line presets", () => {
	it("returns named presets and falls back to the default preset for unknown names", () => {
		expect(getPreset("minimal")).toBe(STATUS_LINE_PRESETS.minimal);
		expect(getPreset("custom")).toBe(STATUS_LINE_PRESETS.custom);
		expect(getPreset("missing-preset")).toBe(STATUS_LINE_PRESETS.default);
	});
});
