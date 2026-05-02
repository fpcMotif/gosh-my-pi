import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("--plugin-dir flag parsing", () => {
	it("parses single --plugin-dir", () => {
		expect(parseArgs(["--plugin-dir", "./my-plugin"]).pluginDirs).toEqual(["./my-plugin"]);
	});

	it("parses multiple --plugin-dir flags", () => {
		expect(parseArgs(["--plugin-dir", "./a", "--plugin-dir", "./b"]).pluginDirs).toEqual(["./a", "./b"]);
	});

	it("returns undefined when no --plugin-dir", () => {
		expect(parseArgs([]).pluginDirs).toBeUndefined();
	});

	it("ignores --plugin-dir with no value", () => {
		expect(parseArgs(["--plugin-dir"]).pluginDirs).toBeUndefined();
	});
});
