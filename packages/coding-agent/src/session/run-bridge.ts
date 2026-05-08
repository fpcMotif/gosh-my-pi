// Run bridge — `OMP_RECOVERY_POLICY`-gated wrapper around `Agent.prompt` /
// `Agent.continue` that routes through `AgentRunController` via
// `Effect.runPromiseExit` when the env flag is set, and calls the Agent
// methods directly otherwise. Closes the last unfinished P3b.5+ deferred
// item from the migration plan.
//
// Per ADR-0003 / ADR-0004:
//   - Failure channel preserves the typed `AgentRunError` so existing
//     `instanceof AgentBusy` / `instanceof ContextOverflow` checks at every
//     throw site keep working byte-for-byte (the controller's
//     `mapToAgentRunError` re-uses the same instances when possible).
//   - The bridge does NOT replace `RetryController` — it sits inside the
//     same boundary and only changes how individual `Agent.prompt` /
//     `Agent.continue` invocations are dispatched.
//
// Test seam: callers pass `enabled` explicitly so tests can exercise both
// branches without mutating `process.env` (forbidden per AGENTS.md
// "Testing Guidance" — full-suite-safe rule).

import {
	type Agent,
	AgentRunController,
	type AgentRunRequest,
	LiveClock,
	type RecoveryMarker,
} from "@oh-my-pi/pi-agent-core";
import { Cause, Effect, Layer, Option } from "@oh-my-pi/pi-utils/effect";
import { makeRecoveryMarkerLayer } from "./recovery-marker-live";
import type { SessionManager } from "./session-manager";

/** Env var name + on-value for the gated runtime path. Single source of truth. */
export const RECOVERY_POLICY_ENV_VAR = "OMP_RECOVERY_POLICY";
export const RECOVERY_POLICY_ENABLED = "1";

/** Returns true when `OMP_RECOVERY_POLICY` is set to `"1"` in the current process. */
export function isRecoveryPolicyEnabled(): boolean {
	return process.env[RECOVERY_POLICY_ENV_VAR] === RECOVERY_POLICY_ENABLED;
}

/**
 * Runtime options for the bridge. `enabled` is normally
 * `isRecoveryPolicyEnabled()` but is taken as an explicit parameter so tests
 * can pin both branches deterministically.
 */
export interface RunAgentRequestOptions {
	/** When `true`, route through `AgentRunController.run` + `Effect.runPromiseExit`. */
	readonly enabled: boolean;
}

/**
 * Dispatch an `AgentRunRequest` against `agent`. When `options.enabled` is
 * `true`, runs through `AgentRunController` with the Live `RecoveryMarker`
 * Layer (writes markers via `sessionManager`'s `appendRecoveryMarker`) and
 * `LiveClock`. When `false`, calls `agent.prompt` / `agent.continue`
 * directly — same byte-for-byte path the codebase used pre-P3.
 *
 * Failure semantics (enabled branch):
 *   - `Exit.Failure` with a typed `AgentRunError` cause → re-throws the
 *     original tagged-error instance (preserves `instanceof` for
 *     `AgentBusy`, `ContextOverflow`, etc.).
 *   - `Exit.Failure` with no extractable failure (defect / interrupt) →
 *     re-throws a generic `Error` with the pretty-printed cause.
 */
export async function runAgentRequest(
	agent: Agent,
	sessionManager: SessionManager,
	request: AgentRunRequest,
	options: RunAgentRequestOptions,
): Promise<void> {
	if (!options.enabled) {
		await runDirect(agent, request);
		return;
	}

	const controller = new AgentRunController(agent);
	const liveLayer: Layer.Layer<RecoveryMarker> = makeRecoveryMarkerLayer(sessionManager);
	const program = controller.run(request).pipe(Effect.provide(liveLayer), Effect.provide(LiveClock));
	const exit = await Effect.runPromiseExit(program);

	if (exit._tag === "Success") return;

	const failure = Cause.findErrorOption(exit.cause);
	if (Option.isSome(failure)) {
		throw failure.value;
	}
	throw new Error(`AgentRunController failed: ${String(Cause.squash(exit.cause))}`);
}

async function runDirect(agent: Agent, request: AgentRunRequest): Promise<void> {
	if (request.kind === "continue") {
		await agent.continue();
		return;
	}
	const { input, images, options } = request;
	// Only the (string, images, options) overload accepts the images parameter;
	// for everything else (string-without-images, AgentMessage, AgentMessage[])
	// the (input, options) overload covers all union variants of `input`.
	if (typeof input === "string" && images !== undefined) {
		await agent.prompt(input, images, options);
		return;
	}
	await agent.prompt(input, options);
}
