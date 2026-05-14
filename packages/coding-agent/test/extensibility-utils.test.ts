import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createNoOpUIContext, resolvePath } from "../src/extensibility/utils";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

describe("resolvePath", () => {
	it("rejects local scheme paths that require protocol-aware resolution", () => {
		expect(() => resolvePath("local://handoffs/result.json", "/repo")).toThrow("must be resolved");
	});

	it("resolves relative paths from the provided working directory", () => {
		expect(resolvePath("docs/readme.md", "/repo")).toBe(path.join("/repo", "docs", "readme.md"));
	});

	it("leaves absolute paths unchanged", () => {
		expect(resolvePath("/var/tmp/file.txt", "/repo")).toBe("/var/tmp/file.txt");
	});
});

describe("createNoOpUIContext", () => {
	it("returns inert headless UI operations", async () => {
		const ui = createNoOpUIContext();

		await expect(ui.select("Pick", ["one"])).resolves.toBeUndefined();
		await expect(ui.confirm("Confirm", "Continue?")).resolves.toBe(false);
		await expect(ui.input("Name")).resolves.toBeUndefined();
		await expect(ui.editor("Edit")).resolves.toBeUndefined();
		expect(ui.getEditorText()).toBe("");
		expect(ui.theme).toBeDefined();
	});
});
