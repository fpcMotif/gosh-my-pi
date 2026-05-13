import { afterEach, describe, expect, it } from "bun:test";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "@oh-my-pi/pi-ai/utils/idle-iterator";

const ENV_KEYS = ["PI_OPENAI_STREAM_IDLE_TIMEOUT_MS", "PI_STREAM_FIRST_EVENT_TIMEOUT_MS"] as const;
const originalEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

for (const key of ENV_KEYS) {
	originalEnv.set(key, Bun.env[key]);
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = original;
		}
	}
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[key];
	} else {
		Bun.env[key] = value;
	}
}

async function* yieldNumbers(values: number[]): AsyncGenerator<number> {
	for (const value of values) {
		yield value;
	}
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of iterable) out.push(value);
	return out;
}

function pendingIterable<T>(onReturn?: () => Promise<IteratorResult<T>>): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return {
				next: () => Promise.withResolvers<IteratorResult<T>>().promise,
				return: onReturn,
			};
		},
	};
}

describe("stream idle iterator helpers", () => {
	it("normalizes OpenAI idle timeout environment values", () => {
		setEnv("PI_OPENAI_STREAM_IDLE_TIMEOUT_MS", undefined);
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(120_000);

		setEnv("PI_OPENAI_STREAM_IDLE_TIMEOUT_MS", "not-a-number");
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(120_000);

		setEnv("PI_OPENAI_STREAM_IDLE_TIMEOUT_MS", "0");
		expect(getOpenAIStreamIdleTimeoutMs()).toBeUndefined();

		setEnv("PI_OPENAI_STREAM_IDLE_TIMEOUT_MS", "42.9");
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(42);
	});

	it("normalizes first-event timeout with an idle-aware fallback", () => {
		setEnv("PI_STREAM_FIRST_EVENT_TIMEOUT_MS", undefined);
		expect(getStreamFirstEventTimeoutMs()).toBe(100_000);
		expect(getStreamFirstEventTimeoutMs(150_000)).toBe(150_000);

		setEnv("PI_STREAM_FIRST_EVENT_TIMEOUT_MS", "bad");
		expect(getStreamFirstEventTimeoutMs(10)).toBe(100_000);

		setEnv("PI_STREAM_FIRST_EVENT_TIMEOUT_MS", "0");
		expect(getStreamFirstEventTimeoutMs()).toBeUndefined();
	});

	it("creates a watchdog only for positive timeouts", async () => {
		expect(createWatchdog(undefined, () => {})).toBeUndefined();
		expect(createWatchdog(0, () => {})).toBeUndefined();

		const { promise, resolve } = Promise.withResolvers<void>();
		const watchdog = createWatchdog(5, resolve);
		expect(watchdog).toBeDefined();
		await promise;
		if (watchdog !== undefined) clearTimeout(watchdog);
	});

	it("passes through all items when both first-item and idle timeouts are disabled", async () => {
		let watchdogFired = false;
		const watchdog = setTimeout(() => {
			watchdogFired = true;
		}, 1_000);

		const out = await collect(
			iterateWithIdleTimeout(yieldNumbers([1, 2]), {
				watchdog,
				errorMessage: "idle",
			}),
		);

		expect(out).toEqual([1, 2]);
		await Bun.sleep(1);
		expect(watchdogFired).toBe(false);
	});

	it("uses the first-item timeout and calls the source return hook on timeout", async () => {
		let firstTimedOut = false;
		let returned = false;

		await expect(
			collect(
				iterateWithIdleTimeout(
					pendingIterable<number>(() => {
						returned = true;
						return Promise.reject(new Error("return failed"));
					}),
					{
						firstItemTimeoutMs: 5,
						idleTimeoutMs: 1_000,
						errorMessage: "idle timeout",
						firstItemErrorMessage: "first item timeout",
						onFirstItemTimeout: () => {
							firstTimedOut = true;
						},
					},
				),
			),
		).rejects.toThrow("first item timeout");

		expect(firstTimedOut).toBe(true);
		expect(returned).toBe(true);
	});

	it("falls back to the generic message for first-item timeout", async () => {
		await expect(
			collect(
				iterateWithIdleTimeout(pendingIterable<number>(), {
					firstItemTimeoutMs: 5,
					idleTimeoutMs: 1_000,
					errorMessage: "generic timeout",
				}),
			),
		).rejects.toThrow("generic timeout");
	});

	it("uses the idle timeout after the first item", async () => {
		let idleTimedOut = false;
		async function* slowEvents(): AsyncGenerator<number> {
			yield 1;
			await Bun.sleep(50);
			yield 2;
		}

		await expect(
			collect(
				iterateWithIdleTimeout(slowEvents(), {
					idleTimeoutMs: 5,
					errorMessage: "idle timeout",
					onIdle: () => {
						idleTimedOut = true;
					},
				}),
			),
		).rejects.toThrow("idle timeout");

		expect(idleTimedOut).toBe(true);
	});

	it("returns cleanly when the source completes while idle timeout is active", async () => {
		const out = await collect(
			iterateWithIdleTimeout(yieldNumbers([1]), {
				idleTimeoutMs: 1_000,
				errorMessage: "idle timeout",
			}),
		);

		expect(out).toEqual([1]);
	});

	it("allows a first-item timeout without enforcing later idle gaps", async () => {
		const out = await collect(
			iterateWithIdleTimeout(yieldNumbers([1, 2]), {
				firstItemTimeoutMs: 1_000,
				errorMessage: "idle timeout",
			}),
		);

		expect(out).toEqual([1, 2]);
	});

	it("propagates source errors after the first item when later idle gaps are disabled", async () => {
		const failure = new Error("second item failed");
		let step = 0;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					next: async () => {
						step += 1;
						if (step === 1) return { done: false, value: 1 };
						throw failure;
					},
				};
			},
		};

		await expect(
			collect(
				iterateWithIdleTimeout(source, {
					firstItemTimeoutMs: 1_000,
					errorMessage: "idle timeout",
				}),
			),
		).rejects.toBe(failure);
	});

	it("propagates source iterator errors", async () => {
		const failure = new Error("source failed");
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					next: async () => {
						throw failure;
					},
				};
			},
		};

		await expect(
			collect(
				iterateWithIdleTimeout(source, {
					idleTimeoutMs: 1_000,
					errorMessage: "idle timeout",
				}),
			),
		).rejects.toBe(failure);
	});
});
