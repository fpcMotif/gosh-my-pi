// Contracts for the AbortSignal <-> Effect Fiber bridge.
// These guard the seam P3 onwards leans on for cancellation interop.

import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Fiber } from "@oh-my-pi/pi-utils/effect";
import { effectFromSignal, signalFromFiber } from "../src/effect-signal";

describe("effectFromSignal", () => {
	it("returns the program's result when the signal never aborts", async () => {
		const { signal } = new AbortController();
		const result = await Effect.runPromise(effectFromSignal(signal, Effect.succeed(42)));
		expect(result).toBe(42);
	});

	it("interrupts immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(Effect.runPromise(effectFromSignal(controller.signal, Effect.succeed(42)))).rejects.toThrow();
	});

	it("interrupts the running program when the signal aborts mid-execution", async () => {
		const controller = new AbortController();
		const program = Effect.promise(() => Bun.sleep(500));
		const promise = Effect.runPromise(effectFromSignal(controller.signal, program));
		await Bun.sleep(10);
		controller.abort();
		await expect(promise).rejects.toThrow();
	});

	it("does not leak the abort listener after the program completes", async () => {
		const controller = new AbortController();
		const addSpy = spyOn(controller.signal, "addEventListener");
		const removeSpy = spyOn(controller.signal, "removeEventListener");
		await Effect.runPromise(effectFromSignal(controller.signal, Effect.succeed(42)));
		expect(addSpy.mock.calls.length).toBe(1);
		expect(removeSpy.mock.calls.length).toBe(1);
		addSpy.mockRestore();
		removeSpy.mockRestore();
	});
});

describe("signalFromFiber", () => {
	it("aborts the signal when the fiber fails", async () => {
		const fiber = Effect.runFork(Effect.fail("boom"));
		const signal = signalFromFiber(fiber);
		// Wait for the fiber to complete; ignore the failure since we just need exit observation.
		await Effect.runPromise(Effect.exit(Fiber.await(fiber)));
		await Bun.sleep(0);
		expect(signal.aborted).toBe(true);
	});

	it("does not abort the signal when the fiber succeeds", async () => {
		const fiber = Effect.runFork(Effect.succeed(42));
		const signal = signalFromFiber(fiber);
		await Effect.runPromise(Fiber.await(fiber));
		await Bun.sleep(0);
		expect(signal.aborted).toBe(false);
	});
});
