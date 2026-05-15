// RecoveryMarker — the Effect service used by coding-agent's RecoveryLedger
// writer adapter to append `event: "recovery-marker"` JSONL lines into the
// session log at three safe points (after `message_end`, after each
// `tool_execution_end`, after `turn_end`). The classifier in `RecoveryPolicy`
// (in coding-agent) reads these on session reopen to decide whether the prior
// process exit left the agent in `safe` / `mid-stream` / `mid-tool` state.
//
// Per ADR-0003: thin pass-through. The Live binding (in coding-agent) just
// appends one JSONL line via the existing NdjsonFileWriter; no new
// durability infrastructure is introduced. AgentRunController intentionally
// does not depend on this service; marker emission belongs to the event-stream
// write-side ledger.
//
// Naming policy: `recovery-marker` is the canonical term per CONTEXT.md.
// Avoid: `turn-checkpoint`, `durable-checkpoint`, `snapshot`.

import { Context, Effect, Layer } from "@oh-my-pi/pi-utils/effect";
import type { SessionStorageError } from "../errors";

/**
 * Payload of a single `event: "recovery-marker"` JSONL entry. Identifies the
 * point in the agent run timeline at which the marker was emitted; the
 * `RecoveryPolicy` classifier reads the latest marker plus the trailing
 * session entries to decide the recovery action on reopen.
 */
export interface RecoveryMarkerPayload {
	/**
	 * Monotonic per-session counter, incremented on each marker. Used by
	 * `RecoveryPolicy` to spot the latest marker in the log tail.
	 */
	readonly generation: number;
	/**
	 * Sequence number of the most recent `AgentEvent` emitted before this
	 * marker was appended. The `RecoveryPolicy` correlates against the
	 * trailing entries to detect orphaned events.
	 */
	readonly lastEventSeq: number;
	/**
	 * `true` if the marker was appended while a streaming assistant message
	 * was in flight (between `message_start` and `message_end`); `false`
	 * otherwise. `RecoveryPolicy` uses this to discriminate `mid-stream`
	 * from `safe` / `mid-tool`.
	 */
	readonly isStreaming: boolean;
	/**
	 * Tool calls dispatched in this turn but not yet observed
	 * `tool_execution_end` for. Drives the `mid-tool` recovery branch:
	 * for each pending id, RecoveryPolicy appends a synthetic
	 * `tool_execution_end` with `isError: true,
	 * errorMessage: "interrupted by crash"` and continues.
	 * **Never re-runs the tool.**
	 */
	readonly pendingToolCallIds: readonly string[];
	/** Wall-clock millisecond timestamp captured at append time. */
	readonly timestamp: number;
}

/** Public shape of the RecoveryMarker service. */
export interface RecoveryMarkerShape {
	readonly append: (payload: RecoveryMarkerPayload) => Effect.Effect<void, SessionStorageError>;
}

/** Service tag for the RecoveryMarker Layer. */
export class RecoveryMarker extends Context.Service<RecoveryMarker, RecoveryMarkerShape>()(
	"@oh-my-pi/pi-agent-core/RecoveryMarker",
) {}

/**
 * Layer that drops every marker on the floor. Used by tests that exercise
 * marker-writing code without durability.
 */
export const NoopRecoveryMarker: Layer.Layer<RecoveryMarker> = Layer.succeed(RecoveryMarker)({
	append: () => Effect.void,
});
