// AgentRunController — the Effect-side wrapper introduced by ADR-0003.
// A thin shell over `Agent.prompt` / `Agent.continue` that exposes the call
// as `Effect<void, AgentRunError, RecoveryMarker | Clock>` so retries,
// recovery, and durability hooks become Layer seams instead of inline
// try/catch.
//
// Owns no new state. The marker emission itself happens in coding-agent's
// `#handleAgentEvent` reactive subscription (P3b.4), which already
// observes every AgentEvent. The controller's typed dependency on
// RecoveryMarker means the OUTER seam (Agent.prompt's
// OMP_RECOVERY_POLICY-gated branch) must provide a Layer — Live in
// production (writing to NdjsonFileWriter via SessionManager.appendRecoveryMarker)
// or NoopRecoveryMarker in tests that don't care about durability.
//
// Public callers see `Promise<void>` — `Effect.runPromiseExit` lives at
// the seam, with `Cause.failureOption` unwrapping the typed error so
// existing `instanceof AgentBusy` / `instanceof ContextOverflow` checks
// at every throw site keep working byte-for-byte.
//
// Per ADR-0003: AgentRunController sits INSIDE the existing
// `RetryController` / `ActiveRetryFallback` boundary; does NOT replace
// them. RetryController keeps owning the in-process retry loop.
//
// CONTEXT.md:474-484 documents the term + the avoid list.

import { Effect } from "@oh-my-pi/pi-utils/effect";
import type { Agent } from "../agent";
import { AgentBusy, type AgentRunError, ConfigInvalid } from "../errors";
import type { AgentMessage, AgentPromptOptions, ImageContent } from "../types";
import type { Clock } from "./clock";
import type { RecoveryMarker } from "./recovery-marker";

/**
 * Discriminated request to AgentRunController. Mirrors the two public
 * entry points on `Agent`. The controller picks the right method to call
 * inside the Effect program.
 */
export type AgentRunRequest =
	| {
			readonly kind: "prompt";
			readonly input: string | AgentMessage | AgentMessage[];
			readonly images?: ImageContent[];
			readonly options?: AgentPromptOptions;
	  }
	| { readonly kind: "continue" };

/** Tags of the tagged-error variants that AgentRunController will pass through verbatim. */
const AGENT_RUN_ERROR_TAGS: readonly string[] = [
	"AgentBusy",
	"ConfigInvalid",
	"ProviderHttpError",
	"UsageLimitError",
	"LocalAbort",
	"ToolExecError",
	"SessionStorageError",
	"SubprocessAborted",
	"ContextOverflow",
	"TurnAborted",
];

function isAgentRunError(value: unknown): value is AgentRunError {
	if (typeof value !== "object" || value === null) return false;
	const tag = (value as { _tag?: unknown })._tag;
	return typeof tag === "string" && AGENT_RUN_ERROR_TAGS.includes(tag);
}

function mapToAgentRunError(cause: unknown): AgentRunError {
	if (isAgentRunError(cause)) return cause;
	// AgentBusyError (in types.ts) extends AgentBusy and pre-dates the tagged
	// tree; pass it through too via instanceof.
	if (cause instanceof AgentBusy) return cause;
	const message = cause instanceof Error ? cause.message : String(cause);
	return new ConfigInvalid({ configId: "agent-run", message, cause });
}

/**
 * Effect-side run controller. One per Agent instance. Methods return
 * Effect programs; the OUTER Promise→Effect seam (in `Agent.prompt`'s
 * OMP_RECOVERY_POLICY branch) executes them via
 * `Effect.runPromiseExit` and unwraps the Exit so callers see the same
 * `Promise<void>` contract.
 */
export class AgentRunController {
	readonly #agent: Agent;

	constructor(agent: Agent) {
		this.#agent = agent;
	}

	/**
	 * Wrap an Agent.prompt or Agent.continue call as an Effect. Failures
	 * surface in the typed channel as AgentRunError; interrupts come from
	 * Effect's interrupt channel (caller-aborted via `effectFromSignal` at
	 * the seam).
	 */
	run(request: AgentRunRequest): Effect.Effect<void, AgentRunError, RecoveryMarker | Clock> {
		const agent = this.#agent;
		return Effect.tryPromise({
			try: async signal => {
				if (request.kind === "prompt") {
					const { input, images, options } = request;
					const promptOptions: AgentPromptOptions | undefined = options;
					if (typeof input === "string" && images !== undefined) {
						await agent.prompt(input, images, promptOptions);
						return;
					}
					if (typeof input === "string") {
						await agent.prompt(input, promptOptions);
						return;
					}
					await agent.prompt(input, promptOptions);
					return;
				}
				await agent.continue();
				return;
			},
			catch: mapToAgentRunError,
		});
	}
}
