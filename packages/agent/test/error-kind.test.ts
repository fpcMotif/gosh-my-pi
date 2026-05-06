import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { describe, expect, test } from "bun:test";
import { classifyAssistantError } from "../src/error-kind";
import { createAssistantMessage, createUsage } from "./helpers";

function errorMessage(error: string, usage?: Partial<AssistantMessage["usage"]>): AssistantMessage {
	const msg = createAssistantMessage([{ type: "text", text: "" }], "error");
	msg.errorMessage = error;
	if (usage) {
		msg.usage = { ...createUsage(), ...usage };
	}
	return msg;
}

describe("classifyAssistantError", () => {
	test("returns undefined for non-error stop reason", () => {
		const msg = createAssistantMessage([{ type: "text", text: "hello" }], "stop");
		expect(classifyAssistantError(msg)).toBeUndefined();
	});

	test("returns fatal when stopReason is error but no errorMessage", () => {
		const msg = createAssistantMessage([], "error");
		expect(classifyAssistantError(msg)?.kind).toBe("fatal");
	});

	test("classifies context overflow from error pattern", () => {
		const msg = errorMessage("prompt is too long: 213462 tokens > 200000 maximum");
		expect(classifyAssistantError(msg, 200000)?.kind).toBe("context_overflow");
	});

	test("classifies silent context overflow when usage exceeds window", () => {
		const msg = errorMessage("some error", { input: 100000, cacheRead: 50000, cacheWrite: 0 });
		// total input = 150_000, contextWindow = 100_000
		const kind = classifyAssistantError(msg, 100000);
		expect(kind?.kind).toBe("context_overflow");
		if (kind?.kind === "context_overflow") {
			expect(kind.usedTokens).toBe(150000);
		}
	});

	test("classifies usage_limit with retryAfterMs from header", () => {
		const msg = errorMessage("usage limit reached. retry-after-ms: 2500");
		const kind = classifyAssistantError(msg);
		expect(kind?.kind).toBe("usage_limit");
		if (kind?.kind === "usage_limit") {
			expect(kind.retryAfterMs).toBe(2500);
		}
	});

	test("classifies usage_limit falls back to reason-based backoff", () => {
		const msg = errorMessage("quota exceeded");
		const kind = classifyAssistantError(msg);
		expect(kind?.kind).toBe("usage_limit");
		if (kind?.kind === "usage_limit") {
			expect(kind.retryAfterMs).toBeGreaterThan(0);
		}
	});

	test("classifies transient with reason", () => {
		const msg = errorMessage("provider overloaded, please retry");
		const kind = classifyAssistantError(msg);
		expect(kind?.kind).toBe("transient");
		if (kind?.kind === "transient") {
			expect(kind.reason).toBe("model_capacity");
		}
	});

	test("classifies transient with retryAfterMs when present", () => {
		const msg = errorMessage("rate limit exceeded. retry-after-ms: 1000");
		const kind = classifyAssistantError(msg);
		expect(kind?.kind).toBe("transient");
		if (kind?.kind === "transient") {
			expect(kind.retryAfterMs).toBe(1000);
			expect(kind.reason).toBe("rate_limit");
		}
	});

	test("classifies fatal for unrecognized error", () => {
		const msg = errorMessage("malformed schema validation failed");
		expect(classifyAssistantError(msg)?.kind).toBe("fatal");
	});

	test("context_overflow takes precedence over usage_limit", () => {
		const msg = errorMessage("usage limit reached: prompt is too long: 1 tokens > 0 maximum");
		expect(classifyAssistantError(msg, 0)?.kind).toBe("context_overflow");
	});
});
