import { describe, expect, test } from "bun:test";
import { RequestCorrelator } from "./request-correlator";

describe("RequestCorrelator", () => {
	test("register + resolve round-trips a value", async () => {
		const c = new RequestCorrelator();
		const { id, promise } = c.register<string>();
		expect(c.has(id)).toBe(true);
		expect(c.pendingCount).toBe(1);
		expect(c.resolve(id, "hello")).toBe(true);
		expect(await promise).toBe("hello");
		expect(c.has(id)).toBe(false);
		expect(c.pendingCount).toBe(0);
	});

	test("register accepts an explicit id", async () => {
		const c = new RequestCorrelator();
		const { id, promise } = c.register<number>({ id: "custom-id" });
		expect(id).toBe("custom-id");
		c.resolve("custom-id", 42);
		expect(await promise).toBe(42);
	});

	test("resolve on unknown id is a no-op returning false", () => {
		const c = new RequestCorrelator();
		expect(c.resolve("never-registered", "value")).toBe(false);
	});

	test("reject rejects the promise and cleans up", async () => {
		const c = new RequestCorrelator();
		const { id, promise } = c.register<string>();
		const reason = new Error("boom");
		expect(c.reject(id, reason)).toBe(true);
		expect(promise).rejects.toThrow("boom");
		expect(c.has(id)).toBe(false);
	});

	test("cancel rejects with default reason and cleans up", async () => {
		const c = new RequestCorrelator();
		const { id, promise } = c.register<string>();
		c.cancel(id);
		expect(promise).rejects.toThrow(/cancelled/);
		expect(c.has(id)).toBe(false);
	});

	test("cancel with custom reason", async () => {
		const c = new RequestCorrelator();
		const { id, promise } = c.register<string>();
		c.cancel(id, "shutdown");
		expect(promise).rejects.toThrow(/shutdown/);
	});

	test("cancelAll cancels every pending request", async () => {
		const c = new RequestCorrelator();
		const a = c.register<string>();
		const b = c.register<string>();
		const x = c.register<string>();
		expect(c.pendingCount).toBe(3);
		expect(c.cancelAll("shutdown")).toBe(3);
		expect(c.pendingCount).toBe(0);
		await Promise.allSettled([a.promise, b.promise, x.promise]).then(results => {
			for (const r of results) {
				expect(r.status).toBe("rejected");
			}
		});
	});

	test("timeout fires and resolves with defaultValue", async () => {
		const c = new RequestCorrelator();
		let timeoutFired = false;
		const { promise } = c.register<string>({
			timeoutMs: 10,
			defaultValue: "fallback",
			onTimeout: () => {
				timeoutFired = true;
			},
		});
		const result = await promise;
		expect(result).toBe("fallback");
		expect(timeoutFired).toBe(true);
		expect(c.pendingCount).toBe(0);
	});

	test("timeout resolves when explicit defaultValue is undefined", async () => {
		const c = new RequestCorrelator();
		const { promise } = c.register<string | undefined>({
			timeoutMs: 10,
			defaultValue: undefined,
		});
		expect(await promise).toBeUndefined();
		expect(c.pendingCount).toBe(0);
	});

	test("timeout without defaultValue rejects", async () => {
		const c = new RequestCorrelator();
		const { promise } = c.register<string>({ timeoutMs: 10 });
		expect(promise).rejects.toThrow(/timed out/);
	});

	test("abort signal fires and resolves with defaultValue", async () => {
		const c = new RequestCorrelator();
		const ac = new AbortController();
		let abortFired = false;
		const { promise } = c.register<string>({
			signal: ac.signal,
			defaultValue: "aborted-default",
			onAbort: () => {
				abortFired = true;
			},
		});
		ac.abort();
		const result = await promise;
		expect(result).toBe("aborted-default");
		expect(abortFired).toBe(true);
	});

	test("abort resolves when explicit defaultValue is undefined", async () => {
		const c = new RequestCorrelator();
		const ac = new AbortController();
		const { promise } = c.register<string | undefined>({
			signal: ac.signal,
			defaultValue: undefined,
		});
		ac.abort();
		expect(await promise).toBeUndefined();
		expect(c.pendingCount).toBe(0);
	});

	test("pre-aborted signal short-circuits to defaultValue", async () => {
		const c = new RequestCorrelator();
		const ac = new AbortController();
		ac.abort();
		const { promise } = c.register<string>({
			signal: ac.signal,
			defaultValue: "pre-aborted",
		});
		expect(await promise).toBe("pre-aborted");
		expect(c.pendingCount).toBe(0);
	});

	test("concurrent requests don't interfere", async () => {
		const c = new RequestCorrelator();
		const a = c.register<string>();
		const b = c.register<string>();
		expect(a.id).not.toBe(b.id);
		c.resolve(a.id, "alpha");
		c.resolve(b.id, "beta");
		expect(await a.promise).toBe("alpha");
		expect(await b.promise).toBe("beta");
	});

	test("generated ids are unique", () => {
		const c = new RequestCorrelator();
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const { id } = c.register();
			ids.add(id);
		}
		expect(ids.size).toBe(100);
	});

	test("timeout cleanup runs after resolve (no late timeout firing)", async () => {
		const c = new RequestCorrelator();
		let lateTimeout = false;
		const { id, promise } = c.register<string>({
			timeoutMs: 50,
			defaultValue: "default",
			onTimeout: () => {
				lateTimeout = true;
			},
		});
		c.resolve(id, "early");
		expect(await promise).toBe("early");
		await Bun.sleep(60);
		expect(lateTimeout).toBe(false);
	});
});
