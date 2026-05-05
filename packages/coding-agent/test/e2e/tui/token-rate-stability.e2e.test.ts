import { describe, expect, it } from "bun:test";
import { calculateTokensPerSecond } from "../../../src/modes/components/status-line/token-rate";

/**
 * Contract: status-line/token-rate.ts must never produce a NaN, Infinity, or
 * negative tokens-per-second value. The calculator runs every status-bar
 * redraw (~10 Hz during streaming) so a single bad input there poisons the
 * displayed rate for the whole turn.
 *
 * Lockdown coverage of the existing guards (Number.isFinite check, MIN_DURATION_MS
 * threshold, future-clock fallback). Each contract here corresponds to a
 * specific code path in calculateTokensPerSecond - if any path silently
 * regresses, the displayed rate breaks visibly.
 */

const baseAssistant = {
	role: "assistant" as const,
	timestamp: 1000,
	usage: { output: 100 },
};

describe("status-line — calculateTokensPerSecond stability", () => {
	it("returns null when there are no assistant messages", () => {
		expect(calculateTokensPerSecond([], false)).toBeNull();
		expect(calculateTokensPerSecond([{ role: "user" }], false)).toBeNull();
	});

	it("returns null when output tokens is zero", () => {
		const messages = [{ ...baseAssistant, usage: { output: 0 }, duration: 1000 }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("returns null when output tokens is NaN", () => {
		const messages = [{ ...baseAssistant, usage: { output: Number.NaN }, duration: 1000 }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("returns null when output tokens is negative", () => {
		const messages = [{ ...baseAssistant, usage: { output: -50 }, duration: 1000 }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("returns null when output tokens is Infinity", () => {
		const messages = [{ ...baseAssistant, usage: { output: Number.POSITIVE_INFINITY }, duration: 1000 }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("returns null when duration is below the 100ms minimum threshold", () => {
		const messages = [{ ...baseAssistant, duration: 50 }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("returns null when duration is negative", () => {
		const messages = [{ ...baseAssistant, duration: -10 }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("returns null when duration is NaN", () => {
		const messages = [{ ...baseAssistant, duration: Number.NaN }];
		expect(calculateTokensPerSecond(messages, false)).toBeNull();
	});

	it("falls back to streaming duration calc when finalised duration is invalid", () => {
		// duration: -1 is invalid → in streaming mode, calculator uses now-timestamp
		const messages = [{ ...baseAssistant, duration: -1, timestamp: 1000 }];
		const rate = calculateTokensPerSecond(messages, true, 2000);
		// 100 tokens / 1000ms = 100 tokens/sec
		expect(rate).toBe(100);
	});

	it("returns null on future-clock skew (now < timestamp) when streaming", () => {
		// nowMs < timestamp → resolvedDurationMs negative → below MIN_DURATION_MS → null
		const messages = [{ ...baseAssistant, timestamp: 5000 }];
		expect(calculateTokensPerSecond(messages, true, 1000)).toBeNull();
	});

	it("computes a finite positive rate for a valid finalised message", () => {
		const messages = [{ ...baseAssistant, duration: 2000, usage: { output: 200 } }];
		const rate = calculateTokensPerSecond(messages, false);
		expect(rate).not.toBeNull();
		expect(Number.isFinite(rate as number)).toBe(true);
		expect(rate).toBeGreaterThan(0);
		expect(rate).toBe(100); // 200 tokens / 2s = 100 t/s
	});

	it("uses the LAST assistant message in a multi-turn conversation", () => {
		const messages = [
			{ role: "user" },
			{ role: "assistant", timestamp: 100, duration: 1000, usage: { output: 50 } },
			{ role: "user" },
			{ role: "assistant", timestamp: 2000, duration: 500, usage: { output: 100 } },
		];
		// Last assistant: 100 tokens / 0.5s = 200 t/s
		expect(calculateTokensPerSecond(messages, false)).toBe(200);
	});

	it("never returns Infinity even when duration is exactly the MIN threshold", () => {
		const messages = [{ ...baseAssistant, duration: 100, usage: { output: 1 } }];
		const rate = calculateTokensPerSecond(messages, false);
		// 1 token / 100ms = 10 t/s — finite, positive
		expect(Number.isFinite(rate as number)).toBe(true);
		expect(rate).toBe(10);
	});
});
