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
 * Discriminated union of every tagged error in the agent runtime. The
 * `errorToKind` bridge in `./error-kind` exhaustively matches against this.
 */
export type AgentTaggedError =
	| AgentBusy
	| ConfigInvalid
	| ProviderHttpError
	| ToolExecError
	| SessionStorageError
	| SubprocessAborted
	| ContextOverflow;
