import { describe, expect, test } from "bun:test";
import { Effect } from "@oh-my-pi/pi-utils/effect";
import { LocalAbort } from "../src/errors";
import { Http, LiveHttp } from "../src/layers/http";
import { STREAM_STALLED_SUFFIX } from "../src/utils/idle-iterator";

async function* yieldThenThrow<T>(item: T, error: Error): AsyncGenerator<T> {
	yield item;
	throw error;
}

async function* yieldOnce<T>(item: T): AsyncGenerator<T> {
	yield item;
}

function runStream<T>(opts: {
	callerSignal?: AbortSignal;
	firstEventWatchdog?: { kind: "timeout" | "idle" | "stall"; timeoutMs: number };
	body: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
}): Promise<AsyncIterable<T>> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const http = yield* Http;
			return yield* http.requestStream<T>(opts);
		}).pipe(Effect.provide(LiveHttp)) as Effect.Effect<AsyncIterable<T>, unknown>,
	) as Promise<AsyncIterable<T>>;
}

describe("HttpShape.requestStream", () => {
	test("happy path → returns iterable, body's signal stays unaborted on success", async () => {
		let observed: AbortSignal | undefined;
		const iterable = await runStream({
			body: async signal => {
				observed = signal;
				return yieldOnce("one");
			},
		});
		const collected: string[] = [];
		for await (const item of iterable) collected.push(item);
		expect(collected).toEqual(["one"]);
		expect(observed?.aborted).toBe(false);
	});

	test("watchdog fires before body resolves → fails with LocalAbort kind=timeout and aborts the body signal", async () => {
		let observed: AbortSignal | undefined;
		const start = Date.now();
		const result = await runStream({
			firstEventWatchdog: { kind: "timeout", timeoutMs: 30 },
			body: async signal => {
				observed = signal;
				await new Promise(() => {});
				return yieldOnce("never");
			},
		}).catch((error: unknown) => error);
		const elapsed = Date.now() - start;
		expect(result).toBeInstanceOf(LocalAbort);
		expect((result as LocalAbort).kind).toBe("timeout");
		expect((result as LocalAbort).durationMs).toBeGreaterThanOrEqual(30);
		expect(elapsed).toBeLessThan(500);
		expect(observed?.aborted).toBe(true);
	});

	test("caller signal aborts → body signal also aborts and the promise rejects", async () => {
		const caller = new AbortController();
		let observed: AbortSignal | undefined;
		const promise = runStream({
			callerSignal: caller.signal,
			body: async signal => {
				observed = signal;
				await new Promise(() => {});
				return yieldOnce("never");
			},
		});
		await Bun.sleep(10);
		caller.abort();
		const result = await promise.catch((error: unknown) => error);
		expect(result).toBeDefined();
		expect(observed?.aborted).toBe(true);
	});

	test("body rejects with stalled-stream Error → re-raised as LocalAbort kind=idle", async () => {
		const result = await runStream({
			body: async () => {
				throw new Error(`some-provider ${STREAM_STALLED_SUFFIX}`);
			},
		}).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(LocalAbort);
		expect((result as LocalAbort).kind).toBe("idle");
	});

	test("body rejects with unrelated Error → re-raised unchanged", async () => {
		const sentinel = new Error("unrelated failure");
		const result = await runStream({
			body: async () => {
				throw sentinel;
			},
		}).catch((error: unknown) => error);
		expect(result).toBe(sentinel);
	});

	test("watchdog timeoutMs <= 0 → watchdog disabled, body runs to completion", async () => {
		const iterable = await runStream({
			firstEventWatchdog: { kind: "timeout", timeoutMs: 0 },
			body: async () => {
				await Bun.sleep(10);
				return yieldOnce("done");
			},
		});
		const collected: string[] = [];
		for await (const item of iterable) collected.push(item);
		expect(collected).toEqual(["done"]);
	});

	test("returned iterable's idle throw propagates from caller's `for await` (not from requestStream itself)", async () => {
		const iterable = await runStream({
			body: async () => yieldThenThrow("first", new Error(`oops ${STREAM_STALLED_SUFFIX}`)),
		});
		const collected: string[] = [];
		const caught = await (async () => {
			try {
				for await (const item of iterable) collected.push(item);
				return null;
			} catch (error: unknown) {
				return error;
			}
		})();
		expect(collected).toEqual(["first"]);
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain(STREAM_STALLED_SUFFIX);
	});
});
