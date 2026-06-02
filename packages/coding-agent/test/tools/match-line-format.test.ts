import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "../../src/tools/match-line-format";

describe("formatMatchLine", () => {
	it("renders plain context lines and hashline match anchors with the stable separator", () => {
		const plain = formatMatchLine(12, "context", false, { useHashLines: false });
		const hashed = formatMatchLine(7, "needle", true, { useHashLines: true });

		expect(plain).toBe(" 12|context");
		expect(hashed).toStartWith("*7");
		expect(hashed).toEndWith("|needle");
		expect(hashed).not.toContain("#");
	});
});
