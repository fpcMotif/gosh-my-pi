import { expect, test } from "bun:test";
import * as path from "node:path";

test("ToolPresentation data types remain frontend-neutral", async () => {
	const source = await Bun.file(path.join(import.meta.dir, "presentation-types.ts")).text();

	expect(source).not.toContain("pi-tui");
	expect(source).not.toContain("/theme");
	expect(source).not.toMatch(/^import /m);
});
