# ADR-0006: RecoveryLedger owns recovery-marker write-side state

Status: accepted
Date: 2026-05-15

## Context

ADR-0003 introduced `RecoveryMarker` and an Effect-side `AgentRunController` seam. During implementation, marker emission belonged to `AgentSession`'s AgentEvent subscription because only that boundary observes the ordered safe points after session persistence: assistant `message_end`, `tool_execution_end`, and `turn_end`.

Keeping a phantom `RecoveryMarker` dependency on `AgentRunController` made the Interface misleading: the controller did not write markers, but callers still had to provide a marker Layer.

## Decision

Introduce `RecoveryLedger` as the write-side Module for ADR-0003 recovery markers.

`RecoveryLedger` owns:

- marker generation counter,
- observed AgentEvent sequence counter,
- pending tool-call IDs,
- the writer Adapter that appends `RecoveryMarker` entries through `SessionManager.appendRecoveryMarker`.

`AgentSession` routes ordered event facts to the ledger. `RecoveryPolicy` remains the read/classify Module on session reopen. `AgentRunController` keeps only the typed run error seam and no longer depends on `RecoveryMarker`.

The `RecoveryMarker` Layer remains a small writer Adapter surface used by ledger tests and live marker append code. It is no longer a required environment for every agent run.

## Consequences

- Marker timing stays coupled to the AgentEvent stream, where the safe points are observable.
- Run dispatch no longer advertises a durability dependency it does not use.
- `RecoveryMarker` remains the persisted line type and Effect service name; the new canonical Module name for write-side state is `RecoveryLedger`.

## Rejected

- **Move marker writes into `AgentRunController`.** Rejected because the controller wraps `Agent.prompt` / `Agent.continue` and does not observe persisted `message_end`, per-tool completion, or `turn_end` ordering.
- **Keep the phantom `RecoveryMarker` dependency on `AgentRunController`.** Rejected because it forced callers and tests to provide a Layer that was never read, obscuring the real write-side owner.
