import { describe, expect, it } from "bun:test";
import { buildSshTarget, sanitizeHostName } from "../src/ssh/utils";

describe("SSH utility formatting", () => {
	it("sanitizes host names for filesystem use with a non-empty fallback", () => {
		expect(sanitizeHostName("prod/us west")).toBe("prod_us_west");
		expect(sanitizeHostName("###")).toBe("_");
		expect(sanitizeHostName("")).toBe("remote");
	});

	it("builds SSH targets only adding the username prefix when present", () => {
		expect(buildSshTarget("deploy", "example.com")).toBe("deploy@example.com");
		expect(buildSshTarget("", "example.com")).toBe("example.com");
		expect(buildSshTarget(undefined, "example.com")).toBe("example.com");
	});
});
