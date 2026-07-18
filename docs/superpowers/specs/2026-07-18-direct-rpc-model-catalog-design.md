# Direct RpcModelCatalog picker

Status: implemented and verified.

## Historical baseline

This section records the pre-change problem. The implementation below replaces
the bridge for the interactive picker.

The TypeScript backend owns model and auth truth. `models.catalog` already
returns models, role assignments, and the active model. Go discards the
top-level roles, converts models into Catwalk `cfg.Providers`, and gives that
projection to the inherited picker.

This bridge causes four real faults:

- picker-open performs a 10-second RPC inside Bubble Tea `Update`;
- failed `set_model` leaves false local selection state;
- successful login retries with `ReAuthenticate` still set and asks to log in
  again;
- failed or cancelled login can retain a stale pending selection.

## Goals

- Make the backend-shaped Model Catalog the sole picker source.
- Preserve all `RpcModelCatalog` fields, including top-level roles.
- Keep interactive-picker RPC work outside Bubble Tea `Update`.
- Commit local role, active-model, and thinking caches only after `set_model`
  succeeds.
- Keep login, refresh, and retry as one bounded transaction.
- Delete the Bridge Model Catalog and synthetic `gmp/gmp-backend` provider.
- Evolve OMP-RPC v1 additively; keep its schema name unchanged.

## Non-goals

- No generic query language or grouping strategy.
- No new wire frame or generated schema.
- No standalone picker state machine.
- No change to backend model resolution or AuthStorage.
- No broad deletion of the inherited `Workspace` interface in this change.

## Chosen design

Use one concrete Model Catalog module owned by `GmpWorkspace`. The UI receives
immutable snapshots. The dialog renders those snapshots and emits selections.
For the interactive picker, only `GmpWorkspace` performs `models.catalog` and
`set_model` RPC calls.

The Go snapshot mirrors the frozen TypeScript shape:

```go
type ModelCatalog struct {
	Models  []ModelCatalogEntry
	Roles   []ModelCatalogRole
	Current *ModelCatalogModel
}
```

Public operations stay small:

```go
func (w *GmpWorkspace) ModelCatalog() ModelCatalog
func (w *GmpWorkspace) RefreshModelCatalog(context.Context) (ModelCatalog, error)
func (w *GmpWorkspace) SelectModel(context.Context, ModelSelection) (ModelSelectionResult, error)
```

`ModelCatalog()` performs no I/O and returns a deep copy under the workspace
read lock.

## Catalog invariants

1. Refresh parses and validates a complete response before one atomic swap.
2. Failed RPC, malformed data, blank references, or duplicate references keep
   the last good snapshot.
3. `roles` is canonical role assignment. Entry `roles` remains display
   metadata. `current` never substitutes for a missing `default` role.
4. Provider and model order is deterministic: display name, then stable id.
5. The dialog receives catalog data directly. It never reads backend model
   truth from `cfg.Providers` or Catwalk.
6. Go does not project backend model truth into `cfg.Models` or
   `cfg.Providers`. The synthetic provider does not exist.
7. The TypeScript `gmp/gmp-backend` response is isolated compatibility for
   older hosts. New Go code cannot request it.

## Selection transaction

`ModelSelection` contains a role, provider, model id, and explicit reauth flag.

1. Find the requested entry in the cached snapshot.
2. If missing, refresh once under the caller deadline and look up again.
3. If unavailable or explicit reauth was requested, return a login requirement
   only when `loginAvailable` is true. Do not mutate state.
4. Otherwise send `set_model` with the selected role.
5. Validate the selected model plus required `activeModel`, `thinkingLevel`,
   and exact role `assignment` receipt fields.
6. After acknowledgement, atomically update the chosen role, active model,
   thinking level, and `AgentModel`. `default` changes the active model;
   named roles only change their role assignment.
7. On any error, preserve all pre-call state.

A login requirement is a result, not an error. Unknown models and unavailable
models without login are typed user errors.

## Bubble Tea flow

- Open: a `tea.Cmd` refreshes with a 10-second deadline. Its result message
  opens the dialog with the returned snapshot.
- Select: a `tea.Cmd` calls `SelectModel` with a 30-second deadline.
- Login required: store one pending selection with `Reauthenticate` cleared,
  then run backend `auth.login`.
- Auth success: refresh, then retry once.
- Auth failure or cancel: clear the pending selection. Never retry.

No RPC call occurs in `Update`. UI state changes only when result messages
return to `Update`.

The interactive UI's first prompt follows the same rule. A bounded command
sends `new_session`. Modern backends return the new `RpcSessionState` in that
receipt, saving a second request. Older v1 backends omit it; Go falls back to
`get_state`. Only a successful result installs the session and starts the
prompt command. The one-shot `gmp-tui-go run` CLI is intentionally separate:
it sends `set_model` (when `--model` is set) and `prompt` directly.

## Dialog boundary

`dialog.NewModels` accepts a `ModelCatalog` snapshot. It groups entries by
provider, shows availability/login labels, and derives selected rows from the
requested role. Filtering and recent-row display remain local rendering work.

The dialog does not own RPC, auth, retry, or workspace mutation.

## Startup and compatibility

`NewGmpWorkspace` is pure. `cmd/root.go` owns a bounded 30-second initial
snapshot: `get_state`, then `get_messages`, under one caller deadline. A
failed snapshot warns and leaves construction intact. `syncState` consumes the
full backend `Model` and exact nullable thinking level, so headers need no
catalog bridge. `Workspace.AgentIsReady()` derives onboarding from the active
backend model snapshot; `Config.IsConfigured()` and `cfg.Providers` are not
readiness signals.

- OMP-RPC v1 evolves additively; the `omp-rpc/v1` schema name is unchanged.
- Backend `RpcModelCatalog` remains the wire contract.
- `cfg.Models` and `cfg.Providers` are not backend model caches.
- The TypeScript `gmp/gmp-backend` compatibility branch stays isolated until a
  supported-host audit can remove it.

## Verification

- Parse and preserve models, roles, current, auth, reasoning, image, and token
  metadata.
- Failed refresh retains the prior snapshot.
- Direct picker renders provider groups without `cfg.Providers`.
- Available selection sends the exact role and commits only after success.
- RPC rejection leaves snapshot, local role, active model, thinking level,
  and `AgentModel` unchanged.
- Unavailable selection routes to login only when login is available.
- Auth success refreshes and retries without reauth looping.
- Auth failure and cancel clear pending state.
- Picker-open proves no synchronous RPC in `Update`.
- Initial state supplies header model capabilities and backend-backed
  onboarding readiness without local config.
- Focused Go tests pass under `-race`; relevant TypeScript catalog tests pass.
- `rg 'gmp-backend|GmpProviderID|cfg\.Providers'` returns no live direct-picker
  bridge path.
- The full Go package suite passes. A built Bubble Tea binary, run in tmux
  against the Bun TypeScript CLI, displays the backend model and both role
  picker modes.

## Completion criteria

- The picker consumes `ModelCatalog` directly.
- Bridge Model Catalog and Synthetic gmp provider are deleted.
- Selection is transactional.
- Catalog and selection RPC calls run only in commands.
- Login continuation terminates on success, failure, or cancellation.
- `CONTEXT.md` names ModelCatalog as the Go projection of `RpcModelCatalog`
  and records the retired adapters.
