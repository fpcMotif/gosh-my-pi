import { afterEach, describe, expect, it, vi } from "bun:test";
import { LocalAbort } from "@oh-my-pi/pi-ai/errors";
import {
	Http,
	HttpError,
	HttpStreamBodyError,
	type HttpStreamOpts,
	LiveHttp,
	makeHttpLayer,
} from "@oh-my-pi/pi-ai/layers/http";
import { Cause, Effect, Exit, Option } from "@oh-my-pi/pi-utils/effect";

afterEach(() => {
	vi.restoreAllMocks();
});

function openStream<T>(opts: HttpStreamOpts<T>): Promise<Exit.Exit<AsyncIterable<T>, unknown>> {
	return Effect.runPromiseExit(
		Effect.gen(function* () {
			const http = yield* Http;
			return yield* http.requestStream<T>(opts);
		}).pipe(Effect.provide(LiveHttp)),
	);
}

function requestWith(
	fetchFn: typeof fetch,
	input: RequestInfo,
	init?: RequestInit,
): Promise<Exit.Exit<Response, HttpError>> {
	return Effect.runPromiseExit(
		Effect.gen(function* () {
			const http = yield* Http;
			return yield* http.request(input, init);
		}).pipe(Effect.provide(makeHttpLayer(fetchFn))),
	);
}

function expectErrorFailure(exit: Exit.Exit<unknown, unknown>): unknown {
	if (!Exit.isFailure(exit)) {
		throw new Error("expected failure exit, got success");
	}
	const failure = Cause.findErrorOption(exit.cause);
	if (Option.isNone(failure)) {
		throw new Error("expected failure cause, got none");
	}
	const value = Option.getOrThrow(failure);
	return value;
}

function expectLocalAbortFailure(exit: Exit.Exit<unknown, unknown>): LocalAbort {
	const value = expectErrorFailure(exit);
	if (!(value instanceof LocalAbort)) {
		throw new Error(`expected LocalAbort, got ${String(value)}`);
	}
	return value;
}

function expectHttpFailure(exit: Exit.Exit<unknown, unknown>): HttpError {
	const value = expectErrorFailure(exit);
	if (!(value instanceof HttpError)) {
		throw new Error(`expected HttpError, got ${String(value)}`);
	}
	return value;
}

function expectInterrupted(exit: Exit.Exit<unknown, unknown>): void {
	expect(Exit.isFailure(exit)).toBe(true);
	if (!Exit.isFailure(exit)) return;
	expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
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

function rejectingIterable(error: Error): AsyncIterable<number> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<number> {
			return {
				next: async () => {
					throw error;
				},
			};
		},
	};
}

function pendingIterable<T>(): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return {
				next: () => Promise.withResolvers<IteratorResult<T>>().promise,
			};
		},
	};
}

describe("Http.requestStream", () => {
	it("request delegates to the supplied fetch and preserves explicit caller signals", async () => {
		const externalController = new AbortController();
		let observedSignal: AbortSignal | null | undefined;
		const fetchFn: typeof fetch = (_input, init) => {
			observedSignal = init?.signal;
			return Promise.resolve(new Response("ok", { status: 201 }));
		};

		const exit = await requestWith(fetchFn, "https://example.test/models", { signal: externalController.signal });

		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(exit.value.status).toBe(201);
		expect(observedSignal).toBe(externalController.signal);
	});

	it("request maps fetch rejection into HttpError with the requested URL", async () => {
		const cause = new Error("network down");
		const fetchFn: typeof fetch = () => Promise.reject(cause);

		const exit = await requestWith(fetchFn, "https://example.test/fail");
		const err = expectHttpFailure(exit);

		expect(err.cause).toBe(cause);
		expect(err.url).toBe("https://example.test/fail");
	});

	it("opens the stream and yields the body's iterable", async () => {
		const exit = await openStream<number>({
			label: "test stream",
			body: () => Promise.resolve(yieldNumbers([1, 2, 3])),
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(await collect(exit.value)).toEqual([1, 2, 3]);
	});

	it("fails with LocalAbort({kind:'timeout'}) when the first-event watchdog elapses before body resolves", async () => {
		const { promise } = Promise.withResolvers<AsyncIterable<number>>();
		const exit = await openStream<number>({
			label: "stuck stream",
			firstEventWatchdog: { kind: "timeout", timeoutMs: 10 },
			body: () => promise,
		});
		const err = expectLocalAbortFailure(exit);
		expect(err.kind).toBe("timeout");
		expect(err.durationMs).toBe(10);
	});

	it("aborts the body's AbortController when the first-event watchdog fires", async () => {
		const { promise } = Promise.withResolvers<AsyncIterable<number>>();
		let capturedSignal: AbortSignal | undefined;
		await openStream<number>({
			label: "stuck stream",
			firstEventWatchdog: { kind: "timeout", timeoutMs: 10 },
			body: signal => {
				capturedSignal = signal;
				return promise;
			},
		});
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("fails with LocalAbort when the stream opens but first item never arrives", async () => {
		let capturedSignal: AbortSignal | undefined;
		const exit = await openStream<number>({
			label: "opened stream",
			firstEventWatchdog: { kind: "timeout", timeoutMs: 10 },
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(pendingIterable<number>());
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;

		await expect(collect(exit.value)).rejects.toBeInstanceOf(LocalAbort);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("caller signal abort interrupts the open Effect and tears down the body signal", async () => {
		const callerController = new AbortController();
		const { promise } = Promise.withResolvers<AsyncIterable<number>>();
		let capturedSignal: AbortSignal | undefined;
		void (async () => {
			await Bun.sleep(5);
			callerController.abort();
		})();
		const exit = await openStream<number>({
			callerSignal: callerController.signal,
			label: "user-cancelled stream",
			firstEventWatchdog: { kind: "timeout", timeoutMs: 5_000 },
			body: signal => {
				capturedSignal = signal;
				return promise;
			},
		});
		expectInterrupted(exit);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("caller signal abort after open tears down the returned iterable", async () => {
		const callerController = new AbortController();
		let capturedSignal: AbortSignal | undefined;
		async function* waitForAbort(signal: AbortSignal): AsyncGenerator<number> {
			yield 1;
			while (!signal.aborted) {
				await Bun.sleep(1);
			}
			yield 2;
		}

		const exit = await openStream<number>({
			callerSignal: callerController.signal,
			label: "iteration-cancelled stream",
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(waitForAbort(signal));
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;

		const iterator = exit.value[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({ done: false, value: 1 });
		callerController.abort();
		await Bun.sleep(2);
		expect(capturedSignal?.aborted).toBe(true);
		await iterator.return?.(undefined);
	});

	it("idle watchdog fires during iteration when inter-event gap exceeds idleTimeoutMs", async () => {
		let capturedSignal: AbortSignal | undefined;
		async function* slowEvents(): AsyncGenerator<number> {
			yield 1;
			await Bun.sleep(50); // > idleTimeoutMs
			yield 2;
		}

		const exit = await openStream<number>({
			label: "OpenAI Codex SSE stream",
			idleTimeoutMs: 10,
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(slowEvents());
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		await expect(collect(exit.value)).rejects.toThrow(/OpenAI Codex SSE stream stalled/);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("fast body + clean iteration: yields all events, no LocalAbort", async () => {
		let capturedSignal: AbortSignal | undefined;
		const exit = await openStream<number>({
			label: "ok stream",
			firstEventWatchdog: { kind: "timeout", timeoutMs: 1_000 },
			idleTimeoutMs: 1_000,
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(yieldNumbers([10, 20]));
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(await collect(exit.value)).toEqual([10, 20]);
		expect(capturedSignal).toBeDefined();
	});

	it("body's signal stays unaborted DURING iteration and is aborted only AFTER iteration ends", async () => {
		let capturedSignal: AbortSignal | undefined;
		const observed: { duringFirst?: boolean; duringLast?: boolean } = {};

		async function* recordingEvents(signal: AbortSignal): AsyncGenerator<number> {
			yield 1;
			observed.duringFirst = signal.aborted;
			yield 2;
			observed.duringLast = signal.aborted;
		}

		const exit = await openStream<number>({
			label: "lifetime test",
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(recordingEvents(signal));
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(await collect(exit.value)).toEqual([1, 2]);
		expect(observed.duringFirst).toBe(false);
		expect(observed.duringLast).toBe(false);
		// Cleanup runs when the iterator finishes (return() called by for-await).
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("body rejection preserves the original failure as a tagged cause and aborts the body signal", async () => {
		const failure = new Error("rate limit");
		let capturedSignal: AbortSignal | undefined;
		const exit = await openStream<number>({
			label: "broken handshake",
			body: signal => {
				capturedSignal = signal;
				return Promise.reject(failure);
			},
		});
		const err = expectErrorFailure(exit);
		expect(err).toBeInstanceOf(HttpStreamBodyError);
		if (!(err instanceof HttpStreamBodyError)) return;
		expect(err.cause).toBe(failure);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("synchronous body defects still clean up the body signal", async () => {
		let capturedSignal: AbortSignal | undefined;
		const exit = await openStream<number>({
			label: "defective stream",
			body: signal => {
				capturedSignal = signal;
				throw new Error("body threw before returning a promise");
			},
		});
		expect(Exit.isFailure(exit)).toBe(true);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("next rejection from the returned iterable runs cleanup", async () => {
		const failure = new Error("stream failed");
		let capturedSignal: AbortSignal | undefined;
		const exit = await openStream<number>({
			label: "rejecting stream",
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(rejectingIterable(failure));
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		await expect(collect(exit.value)).rejects.toBe(failure);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("early iterator return aborts the body signal and is idempotent", async () => {
		let capturedSignal: AbortSignal | undefined;
		let returnValue: unknown;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					next: async () => ({ done: false, value: 1 }),
					return: async value => {
						returnValue = value;
						return { done: true, value: value as number };
					},
				};
			},
		};
		const exit = await openStream<number>({
			label: "returnable stream",
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(source);
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;

		const iterator = exit.value[Symbol.asyncIterator]();
		expect(await iterator.return?.(42)).toEqual({ done: true, value: 42 });
		expect(await iterator.return?.(7)).toEqual({ done: true, value: 7 });
		expect(returnValue).toBe(7);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("early iterator return works when the inner iterator has no return hook", async () => {
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					next: async () => ({ done: false, value: 1 }),
				};
			},
		};
		const exit = await openStream<number>({
			label: "bare stream",
			body: () => Promise.resolve(source),
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;

		const iterator = exit.value[Symbol.asyncIterator]();
		expect(await iterator.return?.(42)).toEqual({ done: true, value: 42 });
	});

	it("iterator throw delegates when available and still cleans up", async () => {
		const failure = new Error("consumer failed");
		let capturedSignal: AbortSignal | undefined;
		let thrown: unknown;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					next: async () => ({ done: false, value: 1 }),
					throw: async err => {
						thrown = err;
						throw err;
					},
				};
			},
		};
		const exit = await openStream<number>({
			label: "throwable stream",
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(source);
			},
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;

		const iterator = exit.value[Symbol.asyncIterator]();
		await expect(iterator.throw?.(failure)).rejects.toBe(failure);
		expect(thrown).toBe(failure);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("iterator throw rethrows when the inner iterator has no throw hook", async () => {
		const failure = new Error("consumer failed");
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					next: async () => ({ done: false, value: 1 }),
				};
			},
		};
		const exit = await openStream<number>({
			label: "bare throwable stream",
			body: () => Promise.resolve(source),
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;

		const iterator = exit.value[Symbol.asyncIterator]();
		await expect(iterator.throw?.(failure)).rejects.toBe(failure);
	});
});
