# apps/tui-go carve-out plan

**Goal**: keep the upstream Crush Bubble Tea TUI + the JSONL bridge to the gmp TypeScript backend. Strip everything that exists only to power Crush's own LLM runtime, sessions, persistence, HTTP server, and OAuth flows.

This is a planning document. Nothing is deleted yet. Use it as the punch list when executing.

---

## Findings

Two passes mapped the codebase:

1. **Bridge translation layer**: `internal/workspace/omp_workspace.go:990-1047` (`parseAgentMessage`) is the seam. It unmarshals `ompclient.AgentEvent.Payload` (raw JSON from `omp --mode rpc`) and produces Crush domain types (`message.Message`, `message.ContentPart`, etc.) that the Bubble Tea views already understand. The `Workspace` interface in `internal/workspace/workspace.go` is the contract; `OmpWorkspace`, `ClientWorkspace`, and `AppWorkspace` each implement it for their respective transports.

2. **UI dependency graph**: `internal/ui/` directly imports 15+ Crush internal packages (chiefly `message`, `session`, `agent`, `app`, `commands`, `history`, `oauth`, `permission`, `lsp`, `hooks`, `skills`, `config`, `pubsub`, `csync`, plus utilities). `go list -deps ./internal/ui/...` yields 61 internal packages in the transitive closure. Crucially, **the UI does NOT import `internal/backend/`, `internal/server/`, `internal/client/`, or `internal/db/` directly or transitively through ompclient/workspace**. Those four are entirely server-side.

3. **`cmd/run.go` + `cmd/root.go` paths**: the entry routes have three modes today —
   - `setupOmpWorkspace()` (omp bridge): `ompclient.Spawn` → `OmpWorkspace`. **No `backend`.**
   - `setupLocalWorkspace()` (in-process Crush): `app.New` → `AppWorkspace`. Uses `backend`, `db`.
   - `connectToServer()` (HTTP client): `client.Client` → `ClientWorkspace`. Uses `client`, hits a remote `gmp serve`.

The carve-out keeps mode 1 and removes modes 2 and 3.

---

## Phase 1 — pure-server deletion (mechanical, low risk)

**Delete entirely:**

- `internal/backend/` (8 files / 923 LOC) — Crush's HTTP backend.
- `internal/server/` (~1500 LOC; `proto.go` alone is 969 LOC) — HTTP server + Swagger.
- `internal/client/` (~750 LOC; `proto.go` 750 LOC) — HTTP client adapter.
- `internal/db/` — sqlc-generated SQLite layer used only by `app`/`backend`/`session` (sub-paths still needed for type shape — see Phase 2).
- `internal/swagger/` — Swagger UI assets.
- `internal/server/` swagger tooling under `sqlc.yaml`.

**Selective deletes within `internal/proto/`:**

| Keep | Delete |
|---|---|
| `proto.go`, `message.go`, `agent.go`, `tools.go`, `permission.go`, `session.go`, `history.go`, `version.go` | `requests.go` (HTTP request DTOs), `mcp.go` (MCP server config DTOs), `server.go` (HTTP server-control DTOs) |

**Selective deletes within `internal/workspace/`:**

| Keep | Delete |
|---|---|
| `workspace.go` (interface + shared types), `omp_workspace.go` (the bridge), `omp_workspace_test.go` | `client_workspace.go`, `app_workspace.go` |

**Selective deletes within `internal/cmd/`:**

| Keep | Delete |
|---|---|
| `root.go` (after pruning), `run.go` (after pruning), `session.go` (read-only session UI command) | `server.go`, `login.go`, `logs.go`, `projects.go`, `dirs.go`, `update_providers.go` |

**`cmd/root.go` and `cmd/run.go` pruning**: drop the `useClientServer()` and `setupLocalWorkspace()` branches; only keep `setupOmpWorkspace()`. Remove their imports of `internal/{client,server,backend,app}`.

**Phase 1 estimated impact**: ~5,500 LOC removed, ~30 files deleted, no UI behavior change. The omp-bridged TUI runs identically.

**Verification gate**: `cd apps/tui-go && go build ./...` after each deletion batch; if a UI file fails to compile because of a removed import, that import wasn't actually pure-server — bump it to Phase 2 instead of forcing through.

---

## Phase 2 — gut Crush runtime, keep type surfaces (medium risk)

The UI imports `internal/agent`, `internal/session`, `internal/message`, `internal/oauth`, `internal/lsp`, `internal/permission`, `internal/hooks`, `internal/skills`, `internal/config`, `internal/commands`, `internal/history`. We can't delete these wholesale because the Bubble Tea views consume their types. We can, however, **reduce each to a thin type-only / pass-through layer** and drop the implementation.

The pattern for each:

1. Identify which exported types the UI references (`grep -r "<pkgname>\." internal/ui/`).
2. Keep those types — usually plain structs / enums in a file like `types.go`.
3. Delete or stub everything else: the runtime loops, the LLM provider integrations, the SQL persistence, the OAuth flows.
4. Where the UI calls a method that mutates state, replace with a stub that emits a JSONL frame to the omp bridge or returns a sensible default.

Per-package shape:

| Package | Strategy | Approx delete % |
|---|---|---|
| `internal/agent/` | Keep `Agent` interface + types (`types.go`, `prompts.go`); delete `agent.go` (loop), `coordinator.go`, `agent/tools/*` (tool registry — gmp owns this), `agent/hyper`, `agent/notify`. | 70-80% |
| `internal/session/` | Keep `Session` struct, IDs, status enum. Delete persistence (`store.go`), branch logic (`branch.go`) — UI only needs to display, not mutate. | 60-70% |
| `internal/message/` | Keep all (`Message`, `ContentPart`, `ToolCall`, `ToolResult`, `Finish`, `MessageRole`, `FinishReason`). UI uses every type. | 0% |
| `internal/oauth/` | Delete entirely. Crush's OAuth (Copilot, Hyper) is replaced by gmp's auth surface. UI dialogs that call into it (`dialog/oauth*.go`) are deleted. | 100% |
| `internal/lsp/` | Keep types only (diagnostic, position) — UI displays them. Delete LSP client (`client.go`) + protocol. | 60% |
| `internal/permission/` | Keep `PermissionRequest` type + the dialog rendering. Replace state machine with a JSONL request-out / response-in shim. | 50% |
| `internal/hooks/` | Keep `Hook` type if UI references it; delete the runner. | 60% |
| `internal/skills/` | Keep skill metadata types; delete loader. | 50% |
| `internal/config/` | Keep model catalog (Catwalk integration is what feeds the cost/context display). Delete provider-key resolution, theme persistence (move to gmp), session config. | 50% |
| `internal/commands/` | Keep slash-command types (the dialog renders them). Delete the executor — gmp dispatches commands by name via JSONL. | 70% |
| `internal/history/` | Likely deletable. UI `history` reads come through `Workspace.History()` which `OmpWorkspace` satisfies via JSONL. Verify before cutting. | 90% |
| `internal/app/` | Reduce to type aliases the UI uses. Delete `app.New`, `app.App` runtime. | 80% |

**Phase 2 estimated impact**: another ~6,000-8,000 LOC removed. Risk is real because the UI depends on these type surfaces — the cut points need careful per-call-site review.

**Per-package execution order** (lowest risk first):
1. `oauth` (delete entirely, plus its three dialogs)
2. `history` (verify deletion)
3. `commands` (executor removal)
4. `skills`, `hooks`, `lsp` (light usage, type-only keeps)
5. `permission` (state machine replacement)
6. `session`, `app`, `agent` (the dense ones, save for last)
7. `config` (cost/context display work)

Each step: delete, fix UI compile errors by bridging through `OmpWorkspace`, run `go build ./...`, commit.

---

## Phase 3 — bridge gaps (architectural)

Things the omp bridge doesn't yet surface that the UI expects:

1. **Tool call streaming with partial JSON args.** Today `OmpWorkspace.parseAgentMessage` produces `ToolResult` only when the tool finishes. To enable inline streaming-diff preview in `chat/file.go` (the killer UX feature for a coding agent), the gmp side must emit `tool_call.input_partial_json` deltas, and `OmpWorkspace` must convert them into a "pending tool with partial args" frame. See "Bubble Tea catalog → Section 6 → the one feature gap" below.

2. **Permission round-trips.** The UI's permission dialog raises a request and waits for a grant/deny. Today this is in-process state. The gmp bridge already has `host_tool_call` / `host_tool_result` correlation (`ompclient.HostToolCallReq` / `HostToolResult`), and `RequestCorrelator` on the TS side handles dedupe. Wire the permission dialog to this same correlator: dialog emits a `host_tool_call`-shaped permission request, gmp tools wait on the response.

3. **Session switching.** Crush's UI has session-picker / session-branching dialogs. gmp's TS side has its own session model. Pick one: surface gmp's session list via JSONL `session_list` query, or drop the UI and reuse the existing TS-side session picker.

4. **Theme management.** Crush owns terminal theming (`internal/ui/styles/theme.go` + Catwalk theme catalog). Keep this — themes are presentational, no need to delegate to gmp.

5. **Catwalk model catalog.** Keep — used for cost/context display in sidebar (`apps/tui-go/internal/ui/model/sidebar.go`). gmp also has model metadata; the two need a single source of truth eventually, but for the carve-out, keep Catwalk as the UI's local catalog.

Each gap is a separate small PR; the carve-out itself doesn't depend on them.

---

## Bubble Tea pattern catalog

The Charm stack the upstream Crush already uses, with our recommendations on what to keep / what to write fresh.

### Charm core stack

- **`charm.land/bubbletea/v2`** — the Elm loop, alt-screen + mouse on by default, typed mouse buttons + focus/paste events.
- **`charm.land/lipgloss/v2`** — `Style` values, `image/color` interfaces, `lipgloss/v2/tree` for structured layouts. Adaptive colors via `lipgloss.AdaptiveColor{Light, Dark}`.
- **`charm.land/bubbles/v2`** — `textinput`, `textarea`, `viewport`, `list`, `table`, `spinner`, `progress`, `paginator`, `key`, `help`, `filepicker`. Most useful here: `textinput`, `textarea`, `key`, `help`, `filepicker`. Avoid `viewport` for the chat log (see below).
- **`charm.land/glamour/v2`** — markdown → ANSI via goldmark + Chroma. Memoize the renderer per width.
- **`charmbracelet/ultraviolet`** — screen buffer + rectangle compositing. Crush leans on this for `uiLayout` rectangles + `uv.NewStyledString().Draw(scr, area)`. Keep this pattern for any non-trivial multi-pane layout.
- **`charmbracelet/x/ansi`** — ANSI-aware string ops (`StringWidth`, `Truncate`, `Cut`). Use for any operation on styled text.
- **`charm.land/huh`** — form library. Use only for one-shot wizards (first-run onboarding); not for in-line dialogs in a long-running TUI.
- **`charmbracelet/freeze`** — export rendered output to PNG/SVG. Cheap to add a `/share` command.

### Per-feature mapping

| Feature | Library / file | Notes |
|---|---|---|
| Streaming markdown | `glamour/v2` + per-width renderer cache (`internal/ui/common/markdown.go`) + per-message render cache (`chat/messages.go:153-181`) | Re-render full message through Glamour on each delta is fine up to ~10KB; throttle deltas at the runtime, not the renderer. |
| Tool call cards | `internal/ui/chat/tools.go` (`ToolMessageItem` interface, per-tool `RenderTool` factory) | The status enum + `pendingTool`/`toolHeader`/`joinToolParts` helpers are the cleanest pattern; reuse wholesale and add new tool renderers as needed. |
| Diff viewer | `internal/ui/diffview/diffview.go` (823 LOC) + `aymanbagabas/go-udiff` | Production-grade unified + split, syntax-highlighted, gutter, syntax-highlight cache keyed on `(content, bg)`. Reuse wholesale. Skip `sergi/go-diff`. |
| Multi-pane layout | `uv.Rectangle` rects + per-component `Draw(scr, area)` (`internal/ui/model/ui.go::uiLayout`) | Beats nested `JoinVertical/Horizontal` past 3 panes; overlays draw last over the same screen. |
| Status footer | `lipgloss` styled string + `bubbles/help.Model` | Compute tokens-per-second upstream of the model; UI just divides. Cost from Catwalk catalog. |
| Slash command palette | `bubbles/textinput` + custom `list.FilterableList` + `sahilm/fuzzy` | Crush's `dialog/commands.go`. Avoid `bubbles/list` for filterable command sets — too slow + hard to style. |
| Inline `/`-autocomplete | `internal/ui/completions/` (custom popup) anchored above `textarea` | Imperative `SetQuery` API, not a child `tea.Model`. |
| Modal dialogs | `dialog.Dialog` interface (3 methods) + `Overlay` stack in `dialog/dialog.go:51` | Top dialog gets `HandleMsg`, all `Draw`. Don't try to make every dialog a `tea.Model`. |
| External editor | `charmbracelet/x/editor` + `openEditorMsg` (Crush wires it through `model/ui.go:119`) | Suspends TUI, shells out to `$EDITOR`. |
| File / image picker | `bubbles/filepicker` (`dialog/filepicker.go`) + Kitty graphics protocol via `internal/ui/image/` | Drag-drop = bracketed-paste detection of file URIs (`tea.PasteMsg`). |
| Spinner + thinking | `internal/ui/anim/anim.go` (custom gradient spinner with `StepMsg{ID}` scoping) | Hard to beat. Reuse. |
| Progress bar | `bubbles/progress` for definite progress only | Use only when the runtime emits real percentages. |
| Keymap discoverability | `bubbles/key` + `bubbles/help` | Per-context keymaps; parent UI swaps which map the help bar reads. |

### The differential rendering rules

1. **Don't use `bubbles/viewport` for the chat log.** Re-wraps the entire string on every `SetContent`. Use the upstream `internal/ui/list/list.go` (per-item caching, visible-range computation, O(visible items) per frame).
2. **Cache rendered ANSI per item, keyed by width.** Each message item stores `(rendered, width, height)`. Streaming delta → clear cache only on the message that changed.
3. **State holds raw markdown, not pre-rendered ANSI.** Theme/width changes invalidate cache, never the raw source.
4. **Scroll-on-grow**: a `follow bool` flag. User PgUp / arrow up → set false. `AtBottom()` → set true.
5. **Streaming message ceiling**: ~2000 lines of dense markdown before single Glamour pass drops a frame. Mitigation: render only the **last N kB through Glamour** (treat as `[finalized prefix] + [streaming tail]`). Crush hasn't done this; it's the open optimization.

### The one feature worth investing in

**Inline streaming-diff preview in Edit/MultiEdit tool cards.** Today `chat/file.go:201` early-returns the header until the tool finishes. The killer demo for a coding agent is watching the diff materialize hunk-by-hunk while the model is still typing. Implementation:

1. **gmp side**: emit `tool_call.input_partial_json` deltas on the JSONL channel during streaming (most providers — OpenAI, Anthropic, Vercel AI SDK — surface this natively as `tool_call.delta.input`).
2. **Go side**: extend `ompclient.AgentEvent` parsing in `parseAgentMessage` to recognize `toolcall_delta` and synthesize a partial `ToolCall` with whatever `path` / `old_string` / `new_string` the partial JSON has parsed so far.
3. **UI side**: in `chat/file.go::renderEditTool`, when the tool is still in-flight but `params.OldString`/`NewString` are present (even empty), build a provisional diff via the same `diffview` pipeline and render it in a **pending style** (dimmed colors, no line numbers, "applying…" footer).

Effort: ~500 LOC of Go, ~50 LOC of TS bridge. Single biggest UX delta over today's "show diff after the round-trip."

### Alternatives we considered and rejected

- **`tview`**: widget-heavy, no streaming-friendly pattern, primitive tag styling vs lipgloss. Wrong shape.
- **`tcell` directly**: only worth it if you need cell-level control of every glyph (custom box drawing, terminal multiplexer-grade rendering). Skip; Crush already gets lower-level access via `ultraviolet`.
- **`termdash`** / **`gocui`**: dashboard-leaning, not chat-shaped. Skip.

### Reference TUIs

- **`charmbracelet/crush`** (already vendored at `apps/tui-go/`) — best-in-class for tool cards, diff, streaming. The base we keep.
- **`opencode-ai/opencode`** (Go agent rewrite) — similar tool-card layout, simpler diff, less mature than Crush.
- **`ollama/ollama`** (`ollama run`) — minimalist baseline (viewport + textarea, no tool cards). Worth scanning for the "smallest viable agent UI."
- **`gptscript-ai/clio`**, **`sst/opencode`** — Bubble Tea agents; less component depth than Crush. Worth scanning for status-bar conventions only.
- **`aider`** (Python) — UX inspiration only.

---

## Execution order summary

1. **Land Phase 1** in 3-5 PRs (one per deletion batch: `backend` + `db` + `server` + `client` + `swagger`; then `proto/` selective; then `workspace/` selective; then `cmd/` selective + `root.go`/`run.go` pruning). Verify `go build ./...` + the omp-bridged interactive smoke test after each.
2. **Land Phase 2** package-by-package in the order listed above, lowest-risk first. Each package PR keeps `go build ./...` green.
3. **Phase 3 gaps** are independent; pick whichever unlocks the most value first. Recommend the streaming-diff feature.

Phase 1 alone removes ~5,500 LOC and is mostly mechanical. Phases 2 and 3 are real engineering — gating Phase 2 on Phase 1 landing means we always have a working bridge while we do the harder work.
