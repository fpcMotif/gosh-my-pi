// Contracts for AgentRunController — the thin Effect shell around
// Agent.prompt / Agent.continue. Tests pin the failure-channel mapping so
// the Promise→Effect→Promise round-trip preserves tagged-error fidelity.

import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Option } from "@oh-my-pi/pi-utils/effect";
import { Cause } from "@oh-my-pi/pi-utils/effect";
import { fromPartial } from "@total-typescript/shoehorn";
import type { Agent } from "../../src/agent";
import { AgentBusy, ContextOverflow, ProviderHttpError, TurnAborted } from "../../src/errors";
import { AgentRunController } from "../../src/run/agent-run";
import { LiveClock } from "../../src/run/clock";
import { NoopRecoveryMarker } from "../../src/run/recovery-marker";

const TestLayer = Layer.mergeAll(NoopRecoveryMarker, LiveClock);

function controllerFor(stub: {
	prompt?: unknown;
	continue?: unknown;
	abort?: unknown;
	turnSignal?: AbortSignal;
	lastAbortReason?: "user" | "ttsr" | "streaming-edit-guard" | "unknown";
}): AgentRunController {
	const agent = fromPartial<Agent>({
		turnSignal: stub.turnSignal ?? new AbortController().signal,
		lastAbortReason: stub.lastAbortReason ?? "user",
		...stub,
	});
	return new AgentRunController(agent);
}

async function runUnwrap<E>(
	program: Effect.Effect<void, E, never>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
	const exit = await Effect.runPromiseExit(program);
	if (Exit.isSuccess(exit)) return { ok: true };
	const failure = Cause.findErrorOption(exit.cause);
	if (Option.isSome(failure)) return { ok: false, error: failure.value };
	return { ok: false, error: Cause.squash(exit.cause) };
}

describe("AgentRunController.run — happy path", () => {
	it("resolves when agent.prompt resolves", async () => {
		let called = false;
		const controller = controllerFor({
			prompt: async (input: string) => {
				expect(input).toBe("hi");
				called = true;
			},
		});
		const program = controller.run({ kind: "prompt", input: "hi" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		expect(result.ok).toBe(true);
		expect(called).toBe(true);
	});

	it("resolves when agent.continue resolves", async () => {
		let called = false;
		const controller = controllerFor({
			continue: async () => {
				called = true;
			},
		});
		const program = controller.run({ kind: "continue" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		expect(result.ok).toBe(true);
		expect(called).toBe(true);
	});
});

describe("AgentRunController.run — failure channel preserves tagged errors", () => {
	it("AgentBusy thrown from agent.prompt surfaces as the same instance in the failure channel", async () => {
		const original = new AgentBusy({ message: "already running" });
		const controller = controllerFor({
			prompt: async () => {
				throw original;
			},
		});
		const program = controller.run({ kind: "prompt", input: "x" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe(original);
		expect(result.error).toBeInstanceOf(AgentBusy);
	});

	it("ContextOverflow surfaces with usedTokens preserved", async () => {
		const original = new ContextOverflow({ usedTokens: 200_000 });
		const controller = controllerFor({
			prompt: async () => {
				throw original;
			},
		});
		const program = controller.run({ kind: "prompt", input: "x" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		if (result.ok) {
			expect(result.ok).toBe(false);
			return;
		}
		expect(result.error).toBeInstanceOf(ContextOverflow);
		expect((result.error as ContextOverflow).usedTokens).toBe(200_000);
	});

	it("ProviderHttpError surfaces verbatim (any tagged-error variant in the union)", async () => {
		const original = new ProviderHttpError({
			provider: "kimi",
			status: 502,
			message: "bad gateway",
		});
		const controller = controllerFor({
			continue: async () => {
				throw original;
			},
		});
		const program = controller.run({ kind: "continue" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		if (result.ok) {
			expect(result.ok).toBe(false);
			return;
		}
		expect(result.error).toBe(original);
	});
});

describe("AgentRunController.run — non-tagged errors get wrapped", () => {
	it("a generic Error becomes ConfigInvalid with the message preserved", async () => {
		const controller = controllerFor({
			prompt: async () => {
				throw new Error("kaboom");
			},
		});
		const program = controller.run({ kind: "prompt", input: "x" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		if (result.ok) {
			expect(result.ok).toBe(false);
			return;
		}
		const error = result.error as { _tag?: string; message?: string };
		expect(error._tag).toBe("ConfigInvalid");
		expect(error.message).toBe("kaboom");
	});

	it("a non-Error rejection becomes ConfigInvalid carrying the stringified cause", async () => {
		const controller = controllerFor({
			prompt: async () => {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw "raw string";
			},
		});
		const program = controller.run({ kind: "prompt", input: "x" }).pipe(Effect.provide(TestLayer));
		const result = await runUnwrap(program);
		if (result.ok) {
			expect(result.ok).toBe(false);
			return;
		}
		const error = result.error as { _tag?: string; message?: string; cause?: unknown };
		expect(error._tag).toBe("ConfigInvalid");
		expect(error.message).toBe("raw string");
		expect(error.cause).toBe("raw string");
	});
});

describe("AgentRunController.run — caller abort bridges to TurnAborted", () => {
	it("aborting via the captured turn signal mid-run produces a TurnAborted carrying the agent's lastAbortReason", async () => {
		const turnAbortController = new AbortController();
		const { promise: hangingPrompt, resolve: resolveHangingPrompt } = Promise.withResolvers<void>();
		const controller = controllerFor({
			turnSignal: turnAbortController.signal,
			lastAbortReason: "ttsr",
			prompt: async () => {
				await hangingPrompt;
			},
		});
		const program = controller.run({ kind: "prompt", input: "x" }).pipe(Effect.provide(TestLayer));
		const promise = runUnwrap(program);
		await Bun.sleep(5);
		turnAbortController.abort();
		resolveHangingPrompt();
		const result = await promise;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(TurnAborted);
		const tagged = result.error as TurnAborted;
		expect(tagged.reason).toBe("ttsr");
		expect(tagged.turnId).toMatch(/^[\w-]{8,}$/);
	});
});
