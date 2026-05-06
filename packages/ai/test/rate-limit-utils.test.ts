import { describe, expect, test } from "bun:test";
import {
	classifyTransient,
	isTransientErrorMessage,
	isUsageLimitError,
	parseRetryAfterMsFromString,
} from "../src/rate-limit-utils";

describe("parseRetryAfterMsFromString", () => {
	test("parses retry-after-ms header", () => {
		expect(parseRetryAfterMsFromString("retry-after-ms: 1500")).toBe(1500);
	});

	test("parses retry-after as seconds", () => {
		expect(parseRetryAfterMsFromString("retry-after: 30")).toBe(30000);
	});

	test("parses x-ratelimit-reset-ms relative", () => {
		expect(parseRetryAfterMsFromString("x-ratelimit-reset-ms: 5000")).toBe(5000);
	});

	test("returns undefined when no header present", () => {
		expect(parseRetryAfterMsFromString("rate limit exceeded")).toBeUndefined();
	});
});

describe("classifyTransient", () => {
	test("recognizes Anthropic envelope failures only when before message_start", () => {
		expect(classifyTransient("anthropic stream envelope error: timeout before message_start")).toBe("envelope");
		// envelope error after message_start is NOT envelope — falls through to transport regex
		expect(classifyTransient("anthropic stream envelope error: connection error")).toBe("transport");
	});

	test("classifies rate-limit phrases", () => {
		expect(classifyTransient("rate limit reached")).toBe("rate_limit");
		expect(classifyTransient("too many requests")).toBe("rate_limit");
	});

	test("classifies model-capacity phrases", () => {
		expect(classifyTransient("provider overloaded")).toBe("model_capacity");
		expect(classifyTransient("HTTP 503 service unavailable")).toBe("model_capacity");
	});

	test("classifies server errors", () => {
		expect(classifyTransient("internal server error")).toBe("server_error");
	});

	test("classifies transport errors via fallback regex", () => {
		expect(classifyTransient("fetch failed: socket hang up")).toBe("transport");
		expect(classifyTransient("the socket connection was closed unexpectedly")).toBe("transport");
		expect(classifyTransient("network error: ECONNRESET")).toBe("transport");
	});

	test("returns undefined for non-transient messages", () => {
		expect(classifyTransient("unauthorized: invalid api key")).toBeUndefined();
		expect(classifyTransient("malformed JSON")).toBeUndefined();
	});

	test("isTransientErrorMessage agrees", () => {
		expect(isTransientErrorMessage("rate limit reached")).toBe(true);
		expect(isTransientErrorMessage("unauthorized")).toBe(false);
	});
});

describe("isUsageLimitError", () => {
	test("matches usage-limit phrases", () => {
		expect(isUsageLimitError("usage limit reached")).toBe(true);
		expect(isUsageLimitError("quota exceeded")).toBe(true);
		expect(isUsageLimitError("resource exhausted")).toBe(true);
	});

	test("rejects rate-limit phrases", () => {
		expect(isUsageLimitError("rate limit exceeded for tier")).toBe(false);
	});
});
