import { afterEach, describe, expect, it, vi } from "bun:test";
import { LocalAbort } from "@oh-my-pi/pi-ai/errors";
import { runWithLocalAbortWatchdog } from "@oh-my-pi/pi-ai/utils/abort-effect";
import { Cause, Effect, Exit, Option } from "@oh-my-pi/pi-utils/effect";

afterEach(() => {
	vi.restoreAllMocks();
});

function expectLocalAbortFailure(exit: Exit.Exit<unknown, LocalAbort>): LocalAbort {
	if (!Exit.isFailure(exit)) {
		throw new Error(`expected failure, got success exit`);
	}
	const failure = Cause.findErrorOption(exit.cause);
	if (Option.isNone(failure)) {
		throw new Error(`expected failure cause, got none`);
	}
	const value = Option.getOrThrow(failure);
	if (!(value instanceof LocalAbort)) {
		throw new Error(`expected LocalAbort, got ${String(value)}`);
	}
	return value;
}

describe("runWithLocalAbortWatchdog", () => {
	it("raises LocalAbort({kind:'timeout', durationMs}) when the watchdog fires before the body resolves", async () => {
		const { promise } = Promise.withResolvers<void>();
		const exit = await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				watchdog: { kind: "timeout", timeoutMs: 10 },
				body: () => promise,
			}),
		);
		const err = expectLocalAbortFailure(exit);
		expect(err.kind).toBe("timeout");
		expect(err.durationMs).toBe(10);
	});

	it("aborts the body's AbortController when the watchdog fires", async () => {
		const { promise } = Promise.withResolvers<void>();
		let capturedSignal: AbortSignal | undefined;
		await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				watchdog: { kind: "idle", timeoutMs: 10 },
				body: signal => {
					capturedSignal = signal;
					return promise;
				},
			}),
		);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("interrupts the program (no failure) when the caller signal fires first", async () => {
		const callerController = new AbortController();
		const { promise } = Promise.withResolvers<void>();
		void (async () => {
			await Bun.sleep(5);
			callerController.abort();
		})();
		const exit = await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				callerSignal: callerController.signal,
				watchdog: { kind: "timeout", timeoutMs: 1_000 },
				body: () => promise,
			}),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (!Exit.isFailure(exit)) return;
		expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
	});

	it("aborts the body's AbortController when the caller signal fires", async () => {
		const callerController = new AbortController();
		const { promise } = Promise.withResolvers<void>();
		let capturedSignal: AbortSignal | undefined;
		void (async () => {
			await Bun.sleep(5);
			callerController.abort();
		})();
		await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				callerSignal: callerController.signal,
				watchdog: { kind: "timeout", timeoutMs: 1_000 },
				body: signal => {
					capturedSignal = signal;
					return promise;
				},
			}),
		);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("succeeds when the body resolves before the watchdog elapses", async () => {
		let bodyResolved = false;
		const exit = await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				watchdog: { kind: "timeout", timeoutMs: 1_000 },
				body: async () => {
					await Bun.sleep(2);
					bodyResolved = true;
				},
			}),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(bodyResolved).toBe(true);
	});

	it("treats body rejection as completed work and still aborts the body signal", async () => {
		let capturedSignal: AbortSignal | undefined;
		const exit = await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				watchdog: { kind: "timeout", timeoutMs: 1_000 },
				body: async signal => {
					capturedSignal = signal;
					throw new Error("body failed after stream reported its own error");
				},
			}),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("raises the watchdog kind that was configured (idle vs timeout vs stall)", async () => {
		const { promise } = Promise.withResolvers<void>();
		const exit = await Effect.runPromiseExit(
			runWithLocalAbortWatchdog({
				watchdog: { kind: "stall", timeoutMs: 5 },
				body: () => promise,
			}),
		);
		const err = expectLocalAbortFailure(exit);
		expect(err.kind).toBe("stall");
	});
});
