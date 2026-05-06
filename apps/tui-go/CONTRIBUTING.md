# Contributing to `apps/tui-go/`

## License boundary — read first

This directory is licensed under **FSL-1.1-MIT** (Functional Source License,
Version 1.1, MIT Future License). The rest of this repository is MIT.

By contributing to anything under `apps/tui-go/`, you agree your contribution
is licensed under FSL-1.1-MIT, not MIT. Your contribution converts to MIT
two years after the version it ships in, the same way upstream Crush's code
does.

If you want your contribution to be plain-MIT, contribute outside
`apps/tui-go/` (e.g. to `packages/`, `crates/`, `scripts/`, root docs).

See `./LICENSE.md` and `./NOTICE` for the full license text and fork
attribution.

## Structure

`apps/tui-go/` is a hard fork of [`charmbracelet/crush`](https://github.com/charmbracelet/crush)
at release `v0.65.3`, integrated as the front-end for the `omp` coding agent
that lives in `packages/coding-agent/` (TypeScript, MIT). The Go side and
the TS side communicate via newline-delimited JSON over stdio (`omp --mode rpc`).

The bridge lives in:

- `internal/ompclient/` — RPC transport.
- `internal/workspace/omp_workspace.go` — implements Crush's `Workspace`
  interface against the RPC client.
- `internal/cmd/root.go` — wires the bridge as the default backend and
  honours `OMP_TUI_BACKEND` as a dev override.

When in doubt, do not modify Crush's inherited code paths. Add new code in
the bridge layer above. This keeps `git subtree pull` merges from upstream
Crush manageable.

## Verification

```bash
cd apps/tui-go
go build ./...
go vet ./...
go test -timeout 60s ./internal/workspace ./internal/cmd ./internal/ui/model
```

Integration test (gated, requires `omp` on PATH):

```bash
go test -tags=integration ./internal/ompclient/...
```

## Module path

The module is `github.com/fpcMotif/gosh-my-pi/apps/tui-go`, **not**
`github.com/charmbracelet/crush`. When merging upstream Crush via
`git subtree pull`, conflicts will appear on import lines — resolve by
replacing the upstream module prefix with our fork prefix.

## prd.json — progress board

`apps/tui-go/prd.json` is the committed phase/task ledger. After completing a
task, update it (`scripts/prd.go` helper to come — until then, edit by hand
following `prd.schema.json`). PR reviewers read this for context.
