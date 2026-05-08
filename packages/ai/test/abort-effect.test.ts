import { describe, expect, test } from "bun:test";
import { LocalAbort } from "../src/errors";
import { runWithLocalAbortWatchdog } from "../src/utils/abort-effect";
import { STREAM_STALLED_SUFFIX } from "../src/utils/idle-iterator";

describe("runWithLocalAbortWatchdog", () => {
	test("body resolves cleanly → returns without error and per-call signal not aborted", async () => {
		let observed: AbortSignal | undefined;
		await runWithLocalAbortWatchdog({
			body: async signal => {
				observed = signal;
				await Bun.sleep(5);
			},
		});
		expect(observed).toBeDefined();
		expect(observed?.aborted).toBe(false);
	});

	test("watchdog fires before body resolves → fails with LocalAbort and aborts the per-call signal", async () => {
		let observed: AbortSignal | undefined;
		const start = Date.now();
		const result = await runWithLocalAbortWatchdog({
			firstEventWatchdog: { kind: "timeout", timeoutMs: 30 },
			body: async signal => {
				observed = signal;
				await new Promise(() => {});
			},
		}).catch((error: unknown) => error);
		const elapsed = Date.now() - start;
		expect(result).toBeInstanceOf(LocalAbort);
		expect((result as LocalAbort).kind).toBe("timeout");
		expect((result as LocalAbort).durationMs).toBeGreaterThanOrEqual(30);
		expect(elapsed).toBeLessThan(500);
		expect(observed?.aborted).toBe(true);
	});

	test("caller signal aborts → per-call signal also aborts and the promise rejects", async () => {
		const caller = new AbortController();
		let observed: AbortSignal | undefined;
		const promise = runWithLocalAbortWatchdog({
			callerSignal: caller.signal,
			body: async signal => {
				observed = signal;
				await new Promise(() => {});
			},
		});
		await Bun.sleep(10);
		caller.abort();
		const result = await promise.catch((error: unknown) => error);
		expect(result).toBeDefined();
		expect(observed?.aborted).toBe(true);
	});

	test("body throws stalled-stream Error → re-raised as LocalAbort with kind=idle", async () => {
		const result = await runWithLocalAbortWatchdog({
			body: async () => {
				await Bun.sleep(5);
				throw new Error(`OpenAI responses ${STREAM_STALLED_SUFFIX}`);
			},
		}).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(LocalAbort);
		expect((result as LocalAbort).kind).toBe("idle");
		expect((result as LocalAbort).durationMs).toBeGreaterThanOrEqual(0);
	});

	test("body throws unrelated Error → re-raised unchanged", async () => {
		const sentinel = new Error("unrelated failure");
		const result = await runWithLocalAbortWatchdog({
			body: async () => {
				throw sentinel;
			},
		}).catch((error: unknown) => error);
		expect(result).toBe(sentinel);
	});

	test("watchdog timeoutMs <= 0 → watchdog disabled, body runs to completion", async () => {
		await runWithLocalAbortWatchdog({
			firstEventWatchdog: { kind: "timeout", timeoutMs: 0 },
			body: async () => {
				await Bun.sleep(20);
			},
		});
	});
});
