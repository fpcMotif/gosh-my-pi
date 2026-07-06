import { describe, expect, it } from "bun:test";
import { sanitizeHeaderValue } from "@oh-my-pi/pi-ai/utils/oauth/kimi";

describe("kimi sanitizeHeaderValue", () => {
	it("strips non-ASCII characters from a hostname so the header stays ASCII-only", () => {
		const hostname = "café-☕-北京-MacBook";
		const sanitized = sanitizeHeaderValue(hostname, "unknown");
		expect(sanitized).toBe("caf---MacBook");
		expect(/^[\x20-\x7E]*$/.test(sanitized)).toBe(true);
	});

	it("strips control characters", () => {
		expect(sanitizeHeaderValue("host\r\nname\t01", "unknown")).toBe("hostname01");
	});

	it("passes normal ASCII values through unchanged", () => {
		expect(sanitizeHeaderValue("MacBook-Pro.local", "unknown")).toBe("MacBook-Pro.local");
		expect(sanitizeHeaderValue("Darwin 24.0.0 arm64", "unknown")).toBe("Darwin 24.0.0 arm64");
	});

	it("falls back when sanitizing yields an empty string", () => {
		expect(sanitizeHeaderValue("北京", "unknown")).toBe("unknown");
		expect(sanitizeHeaderValue("   ", "unknown")).toBe("unknown");
		expect(sanitizeHeaderValue("", "unknown")).toBe("unknown");
	});

	it("defaults the fallback to an empty string when omitted", () => {
		expect(sanitizeHeaderValue("北京")).toBe("");
	});
});
