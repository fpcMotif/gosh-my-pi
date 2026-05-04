import { describe, expect, it } from "bun:test";
import { shouldExpandProtocolCwd } from "@oh-my-pi/pi-coding-agent/tools/bash";

describe("shouldExpandProtocolCwd (regression: codemod-induced || -> ?? bug)", () => {
	it("returns true for explicit protocol cwd (skill://)", () => {
		expect(shouldExpandProtocolCwd("skill://foo/bar")).toBe(true);
	});

	it("returns true for agent:// cwd", () => {
		expect(shouldExpandProtocolCwd("agent://baz")).toBe(true);
	});

	it("returns true for local:/ cwd (the buggy ?? short-circuited here)", () => {
		// Bug signature: with `??`, cwd?.includes("://") returned `false`
		// (cwd defined but no scheme), and `??` does NOT default through `false`,
		// so the local:/ branch was never reached and these cwds skipped expansion.
		expect(shouldExpandProtocolCwd("local:/artifacts/run-1")).toBe(true);
	});

	it("returns false for plain absolute paths", () => {
		expect(shouldExpandProtocolCwd("/tmp/foo")).toBe(false);
	});

	it("returns false for plain relative paths", () => {
		expect(shouldExpandProtocolCwd("./subdir")).toBe(false);
	});

	it("returns false for empty string (defined but no scheme)", () => {
		// Critical: with the buggy `cwd?.includes("://") ?? cwd?.includes("local:/") === true`,
		// "" returns false from the first includes(), then `??` keeps `false` instead of
		// evaluating the local:/ branch. Empty string should still report false here.
		expect(shouldExpandProtocolCwd("")).toBe(false);
	});

	it("returns false for undefined cwd", () => {
		expect(shouldExpandProtocolCwd(undefined)).toBe(false);
	});
});
