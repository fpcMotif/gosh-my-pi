// Tagged-error tree for the agent runtime — the typed control-flow channel
// that Effect programs fail with. Distinct from `AgentErrorKind` (in
// `./error-kind`), which is the *event-stream* taxonomy used to classify
// already-emitted assistant message errors for UI rendering.
//
// One-way bridge: tagged errors -> AgentErrorKind via `errorToKind` in
// `./error-kind`. The reverse direction is never needed because the event
// stream never produces Effect failures, it consumes them.
//
// Each class extends `Data.TaggedError(tag)` which itself extends Error, so
// `instanceof Error` and `instanceof AgentBusy` etc. work at every existing
// throw site.

import { Data } from "@oh-my-pi/pi-utils/effect";
import { LocalAbort } from "@oh-my-pi/pi-ai";

// Re-export so existing imports (`@oh-my-pi/pi-agent-core`'s LocalAbort) keep
// resolving. Canonical definition lives in `pi-ai` because the package graph
// runs pi-agent-core -> pi-ai and provider code there can't import upward.
export { LocalAbort };

/** Concurrent operation attempted while the agent was already running. */
export class AgentBusy extends Data.TaggedError("AgentBusy")<{
	readonly message: string;
}> {}

/** Config file failed to load or validate. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
	readonly configId: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** HTTP request to a provider (Codex, Kimi, OpenAI, ...) failed at the transport layer. */
export class ProviderHttpError extends Data.TaggedError("ProviderHttpError")<{
	readonly provider: string;
	readonly status?: number;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** A tool invocation failed during execution (not pre-validation). */
export class ToolExecError extends Data.TaggedError("ToolExecError")<{
	readonly toolName: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Read / write / fsync against the session JSONL log or session-storage failed. */
export class SessionStorageError extends Data.TaggedError("SessionStorageError")<{
	readonly path: string;
	readonly operation: "read" | "write" | "fsync";
	readonly cause: unknown;
}> {}

/** Subprocess (bash, python, LSP, ...) was aborted before it returned. */
export class SubprocessAborted extends Data.TaggedError("SubprocessAborted")<{
	readonly command: string;
	readonly reason: "signal" | "timeout" | "user";
}> {}

/** Conversation context exceeded the model's window; needs compaction. */
export class ContextOverflow extends Data.TaggedError("ContextOverflow")<{
	readonly usedTokens?: number;
}> {}

/**
 * Provider rejected the request because a usage limit was hit (per-minute /
 * per-hour / daily / monthly cap). Distinct from a generic transient HTTP
 * failure: the retry policy here is "wait for `retryAfterMs`" rather than
 * "exponential backoff + model fallback". Closes the bridge gap where
 * `errorToKind` previously had no tagged-error source for `usage_limit`.
 */
export class UsageLimitError extends Data.TaggedError("UsageLimitError")<{
	readonly provider: string;
	readonly retryAfterMs: number;
	readonly reason: "rate_limit" | "daily" | "unknown";
	readonly cause?: unknown;
}> {}

/**
 * Turn aborted: the active AbortSignal was raised mid-turn. Bridges from
 * `effectFromSignal` so an `AgentRunController.run` can fail with a typed
 * error rather than a generic Effect interruption.
 */
export class TurnAborted extends Data.TaggedError("TurnAborted")<{
	readonly turnId: string;
	readonly reason: "user" | "ttsr" | "streaming-edit-guard" | "unknown";
}> {}

/**
 * Discriminated union of every tagged error in the agent runtime. The
 * `errorToKind` bridge in `./error-kind` exhaustively matches against this.
 */
export type AgentTaggedError =
	| AgentBusy
	| ConfigInvalid
	| ProviderHttpError
	| UsageLimitError
	| LocalAbort
	| ToolExecError
	| SessionStorageError
	| SubprocessAborted
	| ContextOverflow
	| TurnAborted;

/**
 * The full union of tagged errors that can surface from a single agent run.
 * Subset of `AgentTaggedError` excluding errors that only fire outside a run
 * (none today; this alias may diverge in future phases).
 *
 * Public type — Effect programs in `packages/agent/src/run/` fail with this.
 */
export type AgentRunError = AgentTaggedError;
