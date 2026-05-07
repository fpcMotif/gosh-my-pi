# ADR 0001: gmp mode uses backend auth and model catalog

## Status

Accepted — 2026-05-07.

## Context

`apps/tui-go` is a fork of charmbracelet/crush that can see two
provider/model systems by virtue of its dual-runtime nature:

1. **Legacy Crush Catalog** — Catwalk plus
   `~/.local/share/crush/crush.json` (provider
   `api_key` / `oauth` blobs) and the per-provider OAuth caches under
   `~/.config/crush/`. Read by Crush's catwalk-driven provider model
   and written by `dialog.NewAPIKeyInput`, `dialog.NewOAuthHyper`,
   `dialog.NewOAuthCopilot`, and `cmd/login.go` (when it reaches
   `c.SetConfigField(... "providers.<id>.api_key", ...)`).

2. **Backend Model Catalog/AuthStorage** — the model registry plus
   SQLite-backed credential store owned by the coding-agent backend.
   Read by every provider integration in gmp and written by the
   backend OAuth controllers
   (`packages/coding-agent/src/modes/rpc/rpc-oauth-controller.ts`).

When `apps/tui-go` is wired in **gmp mode** (the default — see
`internal/cmd/root.go::setupGmpWorkspace`), the running process layout
is:

```
gmp-tui-go (Bubble Tea TUI)
   └── omp --mode rpc           ← spawned subprocess (the gmp backend)
         └── pi-ai integrations
               └── AuthStorage  ← single source of truth for credentials
```

Both systems existing simultaneously means the picker and login flow can
disagree. The TUI screenshot that drove this ADR shows the symptom: the
model picker rendered a synthetic gmp provider as "Configured", while
the auth dialog opened "Enter your OpenAI Key" and offered to write
`~/.local/share/crush/crush.json`. The two views disagreed because they
consulted different stores. After the user typed a key, no provider
integration on the gmp side ever saw it.

## Decision

In gmp mode, **Backend Model Catalog/AuthStorage is the single source of
truth for both model availability and provider credentials**. Crush's
local provider stores are intentionally inert at runtime:

- The backend exposes `models.catalog` over RPC. `GmpWorkspace` converts
  that response into a Bridge Model Catalog for the Go picker, grouped
  by backend provider.
- The old synthetic `gmp` provider remains only a compatibility fallback
  for older bridge clients. It is not the real gmp model catalog.
- The auth-dialog router (`internal/ui/model/ui.go::openAuthenticationDialog`)
  short-circuits in gmp mode: instead of opening
  `dialog.NewAPIKeyInput` / `dialog.NewOAuthHyper` /
  `dialog.NewOAuthCopilot`, it dispatches `auth.login <providerID>` over
  the RPC bridge. The gmp side runs the OAuth flow under
  `RpcOAuthController` and replies with `auth.*` `extension_ui_request`
  frames. The Bubble Tea `dialog.GmpAuth` component handles those
  frames; user input flows back as `extension_ui_response` and is
  finally persisted by `AuthStorage`.
- Selecting an unavailable bridge-catalog model starts backend
  `auth.login`, refreshes `models.catalog` on success, and retries the
  original selection.
- Large Task and Small Task are preserved in the TUI and map to backend
  roles `default` and `smol` via `set_model.role`.
- The `gmp-tui-go login` CLI (`internal/cmd/login.go`) drives the
  same RPC contract as `/login` does in the TUI, but with a
  shell-friendly `authCLIDriver` that prints URLs and reads from
  stdin. It never writes Crush local config.
- `GmpWorkspace.SetProviderAPIKey` is and remains a no-op stub. Any
  caller that still reaches it is out of date and should be migrated
  to the RPC path.
- Crush custom provider definitions can be imported explicitly into
  backend `models.yml`. There is no live merge from Crush config after
  import.

The discriminator is `Workspace.IsGmpMode() bool` — added to the
`Workspace` interface, returns `true` only on `*GmpWorkspace`.

## Consequences

- **UI parity check**: the picker's availability/auth markers and the
  presence/absence of the auth dialog are now both functions of the
  same backend state. The "Configured but asks for OpenAI Key" race is
  closed by construction.
- **Vanilla Crush still works**: `AppWorkspace` and `ClientWorkspace`
  return `IsGmpMode() == false`. Every legacy code path is preserved
  for users who run `gmp-tui-go` against the standalone Crush HTTP
  daemon or in-process `app.App` mode.
- **Legacy Crush stores become migration input only in gmp mode**: any
  pre-existing entries in `~/.config/crush/crush.json` or
  `~/.local/share/crush/crush.json` are ignored at runtime unless the
  user explicitly imports them into backend `models.yml`. We deliberately
  do not delete them — users who switch back to vanilla Crush expect
  their stored keys.
- **Login UX split**: TUI uses the `dialog.GmpAuth` Bubble Tea
  dialog; CLI uses `authCLIDriver` (URL print + stdin read). Both
  walk the same `auth.*` wire.
- **Future provider additions only need gmp side**: adding a new
  OAuth provider requires only an `OAuthController` implementation in
  `pi-ai` and an entry in the gmp side's provider catalog. The Crush
  fork does not need a parallel provider definition.

## Implementation pointers

- `apps/tui-go/internal/workspace/workspace.go` — `IsGmpMode()` on
  the interface.
- `apps/tui-go/internal/workspace/gmp_workspace.go` — bridge-catalog
  translation, role mapping, and `IsGmpMode() = true`.
- `apps/tui-go/internal/ui/dialog/models.go` — picker renders the
  GmpWorkspace-provided Bridge Model Catalog in gmp mode.
- `apps/tui-go/internal/ui/model/ui.go::openAuthenticationDialog`
  — short-circuits to `runGmpAuthCommand` in gmp mode.
- `apps/tui-go/internal/ui/model/ui.go::handleGmpSelectModel`
  — unavailable-model login and selection retry.
- `apps/tui-go/internal/cmd/login.go` — one-shot RPC subprocess
  driver (`authCLIDriver`).
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` —
  `models.catalog`, `set_model.role`, and backend provider auth
  metadata.
- `packages/coding-agent/src/modes/rpc/rpc-oauth-controller.ts` —
  TS-side `RpcOAuthController` that emits `auth.*`
  `extension_ui_request` frames.
- `packages/coding-agent/src/config/import-crush-providers.ts` —
  explicit migration from Crush provider definitions to backend
  `models.yml`.

## Out of scope

- Reconciling stale entries in `~/.local/share/crush/providers.json`
  (the catwalk catalog cache). The picker no longer reads from it in
  gmp mode; the cache rot has no behavioral impact.
- Building a long-running daemon for `crush login` to attach to. The
  one-shot RPC subprocess driver covers the CLI use case without
  introducing new lifecycle surface.
