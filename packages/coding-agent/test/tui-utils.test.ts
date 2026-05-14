import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName } from "../src/modes/theme/theme";
import type { Theme } from "../src/modes/theme/theme";
import { buildTreePrefix, getStateBgColor, getTreeBranch, Hasher, padToWidth } from "../src/tui/utils";

let uiTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Failed to load dark theme for tests");
	uiTheme = loaded;
});

describe("Hasher", () => {
	it("mixes 64-bit numbers and optional null sentinels into stable digests", () => {
		const left = new Hasher().u64(1n).optional(null).digest();
		const right = new Hasher().u64(2n).optional(null).digest();

		expect(left).not.toBe(0n);
		expect(left).not.toBe(right);
	});
});

describe("tree rendering helpers", () => {
	it("formats tree prefixes and branches from the active theme", () => {
		expect(buildTreePrefix([true, false], uiTheme)).toBe(`${uiTheme.tree.vertical}     `);
		expect(getTreeBranch(true, uiTheme)).toBe(uiTheme.tree.last);
		expect(getTreeBranch(false, uiTheme)).toBe(uiTheme.tree.branch);
	});
});

describe("padToWidth", () => {
	it("applies background functions even when width is zero", () => {
		expect(padToWidth("text", 0, value => `[${value}]`)).toBe("[text]");
	});
});

describe("getStateBgColor", () => {
	it("maps success, error, and active states to their background tokens", () => {
		expect(getStateBgColor("success")).toBe("toolSuccessBg");
		expect(getStateBgColor("error")).toBe("toolErrorBg");
		expect(getStateBgColor("running")).toBe("toolPendingBg");
	});
});
