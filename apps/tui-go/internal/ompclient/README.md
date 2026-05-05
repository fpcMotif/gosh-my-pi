# ompclient

Go client for the omp coding-agent RPC mode (`omp --mode rpc`).
Speaks the JSONL protocol defined in
`packages/coding-agent/src/modes/rpc/rpc-types.ts`.

This package is the lowest layer of the omp ↔ Crush TUI bridge. It is
transport-only: it spawns the subprocess, serialises commands, and
fans out responses, agent events, extension UI requests, and host
tool requests as typed Go values.

## Status

- `Spawn`, `Call`, `Send`, `Close` implemented.
- Event fan-out channels wired (`Events`, `ExtensionUIRequests`,
  `HostToolCalls`, `HostToolCancels`).
- Frame dispatch by `type` field; unknown types surface as
  `AgentEvent` with the raw line preserved.

## Wired in this fork

- `internal/workspace/omp_workspace.go` implements Crush's
  `workspace.Workspace` interface for the omp RPC backend.
- `internal/cmd/root.go` starts `omp --mode rpc` by default and uses
  `OMP_TUI_BACKEND` for local backend overrides.

## Verification

This MVP keeps Go verification package-local to `apps/tui-go`; it does
not add Go to the repo's existing Bun/Rust CI.
