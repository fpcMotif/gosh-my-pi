// Live binding for the `RecoveryMarker` Effect service (defined in
// pi-agent-core's `run/recovery-marker.ts`). Wraps a `SessionManager`'s
// `appendRecoveryMarker` Promise method as an Effect that maps any
// thrown error into the typed `SessionStorageError` failure channel.
//
// Per ADR-0003: this is a thin pass-through. We do NOT introduce a new
// durability infrastructure — the existing `NdjsonFileWriter` queue +
// fsync semantics inside SessionManager handle the actual write.

import { type RecoveryMarkerPayload, RecoveryMarker, SessionStorageError } from "@oh-my-pi/pi-agent-core";
import { Effect, Layer } from "@oh-my-pi/pi-utils/effect";
import type { SessionManager } from "./session-manager";

/**
 * Construct a `RecoveryMarker` Layer whose `append` calls
 * `sessionManager.appendRecoveryMarker(payload)` synchronously (the method
 * mutates in-memory state and queues a JSONL write — it returns a string id,
 * not a Promise; persistence happens asynchronously inside SessionManager
 * but errors surface on the next write/close, which is acceptable for the
 * recovery-marker use case).
 *
 * Tests can construct an in-memory recorder by using `NoopRecoveryMarker`
 * from pi-agent-core directly, or by passing a stub SessionManager with a
 * spy on `appendRecoveryMarker`.
 */
export function makeRecoveryMarkerLayer(sessionManager: SessionManager): Layer.Layer<RecoveryMarker> {
	return Layer.succeed(RecoveryMarker)({
		append: (payload: RecoveryMarkerPayload) =>
			Effect.try({
				try: () => {
					sessionManager.appendRecoveryMarker({
						generation: payload.generation,
						lastEventSeq: payload.lastEventSeq,
						isStreaming: payload.isStreaming,
						pendingToolCallIds: [...payload.pendingToolCallIds],
					});
				},
				catch: cause =>
					new SessionStorageError({
						path: "recovery-marker",
						operation: "write",
						cause,
					}),
			}),
	});
}
