# ompclient

Go client for the gmp coding-agent RPC mode (`gmp --mode rpc`).
Speaks the JSONL protocol defined in
`packages/coding-agent/src/modes/rpc/rpc-types.ts`.

This package is the lowest layer of the `gmp-tui-go` ↔ `gmp` bridge. It is
transport-only: it spawns the subprocess, serialises commands, and
fans out responses, agent events, extension UI requests, and host
tool requests as typed Go values.

## Status

- `Spawn`, `Call`, `Send`, `Close` implemented.
- Event fan-out channels wired (`Events`, `ExtensionUIRequests`,
  `HostToolCalls`, `HostToolCancels`).
- Frame dispatch by `type` field; unknown types surface as
  `AgentEvent` with the raw line preserved.
- Every fan-out queue is bounded. Overflow is terminal: the client records
  `ErrIngressFull`, closes all consumer channels, signals `BackendExited`, and
  reaps the subprocess. Required frames never drop or spill into goroutines.

## Wired in this fork

- `internal/workspace/gmp_workspace.go` implements Crush's
  `workspace.Workspace` interface for the gmp RPC backend.
- `internal/cmd/root.go` starts `gmp --mode rpc` by default. Use
  `GMP_TUI_BACKEND` for local backend overrides; `OMP_TUI_BACKEND` remains a
  legacy alias.

## Verification

Go verification remains package-local to `apps/tui-go`; no dedicated Go CI
job exists yet. P7 is closed. A future CI job should run
`go vet ./... && go test ./... && staticcheck ./...` from `apps/tui-go/`.
