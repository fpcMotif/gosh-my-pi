# ADR 0002: apps/tui-go is gmp-only (carve-out Phase 1 lite)

## Status

Accepted — 2026-05-07. Supersedes the "Vanilla Crush still works"
preservation clause in ADR 0001's _Consequences_ section. Bounded
predecessor of the full Phase 1 carve-out
(`apps/tui-go/docs/carve-out-plan.md`), which remains the north star.

## Context

ADR 0001 left `*AppWorkspace` and `*ClientWorkspace` as live code
paths so that `gmp-tui-go` could double as a frontend for vanilla
Crush. In the year since, no cobra command path has actually
exercised those workspaces:

- `setupAppWorkspace` is referenced zero times in the cobra surface.
- `setupClientServerWorkspace` is referenced zero times.
- `setupLocalWorkspace` is reached only from `cmd/run.go` (the
  `gmp-tui-go run` non-interactive entry point), where it spawns
  in-process Crush instead of the gmp RPC backend. In gmp mode this
  silently bypasses `AuthStorage`, the `models.catalog` RPC, and the
  whole choreography ADR 0001 establishes — `gmp-tui-go run` is
  effectively broken under the gmp default.

The cost of preserving the dual-mode surface is paid in
hard-to-find bugs at the seam between the catwalk-shaped UI router
and the gmp RPC driver. The triggering symptom for this ADR is one
such bug:

```
$ gmp-tui-go login
ERROR
Gmp auth.login ack: omp rpc error (auth.login): Unknown: undefined
```

Trace:

1. Go `cmd/login.go` (line 49) defaults `provider := ""` when no
   argument is given, intending to "open a provider picker" per the
   docstring.
2. `ompclient.Command.Provider` carries `omitempty`, so the wire
   frame becomes `{"type":"auth.login"}` with no `provider` key.
3. Backend `rpc-mode.ts` `auth.login` case reads `command.provider`
   as `undefined` and forwards it directly to
   `AuthStorage.login(undefined as OAuthProviderId, …)`.
4. `pi-ai/src/auth-storage.ts:248-250` falls through to its default
   branch: `getOAuthProvider(undefined) → null →
throw new Error("Unknown: ${p}")` — i.e. literally
   `Unknown: undefined`.

The picker the docstring promised is not implemented. The wire
vocabulary (`auth.pick_provider`) and the inbound handlers (Bubble
Tea `dialog.GmpAuth`, CLI `authCLIDriver`, workspace dispatcher)
all exist and are tested. Only the backend emit was never wired.
The bug lives at the dual-mode seam — a seam that exists only
because of preserved code that no real workflow uses.

## Decision

`apps/tui-go` is gmp-only. The dual-mode workspace abstraction is
removed. The carve-out plan in `apps/tui-go/docs/carve-out-plan.md`
remains the long-term north star (Phase 1 full deletes
`internal/{backend,server,client,db,swagger}`; Phase 2 reduces
shared type surfaces). This ADR locks in the **bounded next step**
— Phase 1 _lite_ — that sheds the obviously-unreachable code.

### Wire contract change

The `auth.login` RPC command's `provider` field becomes formally
optional. Empty / missing `provider` is the documented trigger for
a backend-driven picker:

1. Backend receives `auth.login` with no provider.
2. Backend emits `auth.pick_provider` `extension_ui_request`,
   correlated through `RequestCorrelator` with the standard
   timeout / signal semantics every other auth.\* round-trip uses.
3. Host (Bubble Tea dialog or CLI driver) replies with
   `extension_ui_response { value: "<chosen-provider-id>" }` or
   `{ cancelled: true }`.
4. Backend proceeds with `AuthStorage.login(picked)` on success;
   returns a typed error response (`{ success: false, error:
"auth.login cancelled" }` or `{ success: false, error:
"auth.login: no providers available" }`) on cancel / empty.
5. Same single response correlates back to the original
   `auth.login` request — picker is internal to the handler.

### Code changes

Phase 1 lite deletes / rewrites:

| File / symbol                                                                   | Action                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `internal/workspace/app_workspace.go` (393 LOC)                                 | Delete                                                                                                          |
| `internal/workspace/client_workspace.go` (777 LOC)                              | Delete                                                                                                          |
| `cmd/root.go::setupAppWorkspace`                                                | Delete                                                                                                          |
| `cmd/root.go::setupClientServerWorkspace`                                       | Delete                                                                                                          |
| `cmd/root.go::setupLocalWorkspace`                                              | Delete (after `cmd/run.go` rewrite)                                                                             |
| `cmd/run.go` (non-gmp branch)                                                   | Rewrite to use gmp RPC backend                                                                                  |
| `cmd/login.go` (current shell, ~320 LOC)                                        | Replace with thin gmp-RPC-only driver (~50 LOC)                                                                 |
| `cmd/oauth.go`                                                                  | Delete                                                                                                          |
| `internal/ui/dialog/api_key_input.go`                                           | Delete                                                                                                          |
| `internal/ui/dialog/oauth_hyper.go`                                             | Delete                                                                                                          |
| `internal/ui/dialog/oauth_copilot.go`                                           | Delete                                                                                                          |
| `Workspace.IsGmpMode()` interface method                                        | Stays as constant `true` for one transition cycle; removed in a follow-up sweep when consumer sites are updated |
| `cmd/ui.go::openAuthenticationDialog` legacy switch                             | Reduced to `runGmpAuthCommand` only                                                                             |
| `cmd/ui.go::runGmpAuthCommand` empty-provider guard                             | Removed; empty provider now triggers backend picker                                                             |
| `Bridge Model Catalog`, `Synthetic gmp provider` adapters in `gmp_workspace.go` | Stay this turn; deleted when picker migrates to direct `RpcModelCatalog` consumption (separate PR)              |

### Test contract

Two new fixture-driven contract tests anchor the wire vocabulary:

- `packages/coding-agent/src/modes/rpc/rpc-mode.contract.test.ts`
  — drives the in-process `handleCommand` against fake stdio for
  every `RpcCommand` variant, with explicit emphasis on the
  `auth.login` empty-provider → picker → reply → result
  choreography. Catches "wire contract drift" — the bug class that
  produced the failure cited above.
- `apps/tui-go/internal/cmd/login_test.go` — drives `runGmpLogin`
  against an in-memory `ompclient` fake stdio pair, asserting the
  same choreography on the consumer side.

Per-layer unit tests for individual handlers are explicitly out of
scope: each side passed its own tests before the fix and would have
passed them after, because the failure mode was an _agreement_ not a
function. End-to-end smoke (spawning real binaries against a fake
OAuth fixture server) is deferred until a tagged release exists.

### Execution order

Three sequential PRs:

1. **Auth wire fix.** Backend picker emit + Go-side picker dispatch
   (already wired) + TUI `/login` empty-provider guard removal +
   the two contract tests. Smallest defensible chunk; ships the bug
   fix without coupling to deletes.
2. **Mechanical deletes.** Phase 1 lite removals listed above. No
   behavior change; gate is `bun check:ts` + `go build ./... && go
test ./...` green.
3. **`cmd/run.go` rewrite.** `gmp-tui-go run "<prompt>"` becomes a
   thin RPC driver: spawn `gmp --mode rpc`, send `prompt`, drain
   events to stdout, exit. Separate review surface because it's the
   only behavioral change beyond auth.

## Consequences

- The "auth.login: Unknown: undefined" failure mode becomes
  structurally impossible. Empty / missing provider triggers the
  picker; missing provider after picker is a typed wire error;
  invalid provider is a typed wire error. There is no path that
  forwards `undefined` into `AuthStorage.login`.
- ~2,000 LOC removed in PR2 (verified-unreachable code only).
- `IsGmpMode() == false` becomes a dead branch. Consumer sites
  collapse over time; the interface method survives this turn for
  call-site stability.
- `gmp-tui-go run` works correctly in gmp mode for the first time
  (PR3 outcome).
- Future hosts (web, IDE plugins, ACP clients) that drive
  `auth.login` without arguments inherit the picker choreography
  for free — no host-specific picker rendering.
- Vanilla Crush users continue to use the upstream `crush` binary;
  `apps/tui-go` no longer carries a parallel surface for them.
- ADR 0001's auth-store ownership decision stands unchanged. ADR
  0001's _Consequences_ paragraph beginning "Vanilla Crush still
  works" is the only clause superseded.
- CONTEXT.md entries `Bridge Model Catalog`, `Synthetic gmp
provider`, and `Legacy Crush Catalog` are re-framed as adapter
  scaffolding with explicit lifecycles; they remain accurate this
  turn and are deleted alongside the picker rewrite that retires
  the catwalk `cfg.Providers` adapter.

## Implementation pointers

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:773-799` —
  `auth.login` case; gets the empty-provider branch.
- `packages/coding-agent/src/modes/rpc/rpc-types.ts:269-271,
369-374` — `AuthMethod.PickProvider` constant + frame type;
  already defined, ready to emit.
- `apps/tui-go/internal/cmd/login.go:74-129` — `runGmpLogin`;
  drops the local empty-provider intercept.
- `apps/tui-go/internal/ui/model/ui.go:2433` — TUI `/login` guard;
  remove the early return.
- `apps/tui-go/internal/cmd/root.go:230-232` — `setupWorkspace`
  becomes the only entry point; `setupAppWorkspace` /
  `setupClientServerWorkspace` go.
- `apps/tui-go/internal/cmd/run.go:125` — `setupLocalWorkspace`
  call site replaced with the gmp RPC driver in PR3.

## Out of scope

- **Phase 1 full** (deleting `internal/{backend,server,client,db,
swagger}`): the type-surface dependencies into `internal/{agent,
session,message,…}` need separate analysis before those packages
  go.
- **Phase 2** (gutting Crush runtime, keeping type surfaces) — the
  multi-week per-package decomposition described in the carve-out
  plan.
- **Picker-direct `RpcModelCatalog` consumption** (deleting Bridge
  Model Catalog + Synthetic gmp provider adapters): separate PR
  after Phase 1 lite lands. Requires touching the picker
  rendering, not just plumbing.
- **End-to-end smoke against real OAuth providers**: requires a
  fake-OAuth fixture server; revisit when a tagged release exists.
- **`apps/tui-go` directory rename**: the directory still says
  `tui-go` (a generic name); whether to rename it to reflect
  gmp-only is a follow-up cosmetic question.
