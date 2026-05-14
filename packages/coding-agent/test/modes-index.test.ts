import { describe, expect, it } from "bun:test";
import { runPrintMode } from "../src/modes";

describe("modes barrel", () => {
	it("exposes run mode entrypoints", () => {
		expect(runPrintMode).toBeFunction();
	});
});
