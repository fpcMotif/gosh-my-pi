# OMP Architecture Context

Load-bearing concepts shared across the OMP coding-agent and its packages. Keep
terminology consistent here so reviews, ADRs, and architectural sweeps speak
the same language.

## Language

**AgentErrorKind**:
A typed classification of an assistant-message error attached to `AgentEvent`
variants `agent_end` and `message_end`. Populated by pi-agent-core at the
emission boundary. Four variants: `context_overflow`, `usage_limit`,
`transient`, `fatal`.
_Avoid_: error type, error category, error class.

**TransientReason**:
Sub-classification on a transient `AgentErrorKind`. Distinguishes `envelope`,
`transport`, `rate_limit`, `model_capacity`, `server_error`. Surfaced for
telemetry; the consumer treats all transients the same today (model fallback)
but the discriminator is preserved so future code can branch without
re-parsing the original error string.

**AgentSession**:
The stateful per-session orchestrator in `packages/coding-agent/src/session/`.
Owns persistence, retry/compaction policy, and subsystem coordination on top
of the lower-level `Agent` from pi-agent-core. Originally a 6,898-line
god-object; candidate #1b is incrementally decomposing it into focused
controller classes that AgentSession owns and delegates to.

**ActiveRetryFallback**:
First extracted subsystem (#1b pilot). Owns the per-session
"currently-active retry fallback" state plus the methods that mutate it
(apply candidate, restore primary, clear). Lives in
`packages/coding-agent/src/session/active-retry-fallback.ts`. AgentSession
holds one as `#activeRetryFallback` and delegates calls to it. Takes an
`ActiveRetryFallbackContext` interface so it can be unit-tested without
instantiating a full session.

**RetryController**:
Second extracted subsystem (#1b). Owns the per-session retry-attempt loop:
the attempt counter, the awaitable promise consumers can `waitFor()`, the
abort controller for the current backoff sleep. On a retryable error
(driven by `errorKind`), decides whether to retry, runs credential / model
fallback (delegating to `ActiveRetryFallback`), sleeps with exponential
backoff, then schedules a continue. Lives in
`packages/coding-agent/src/session/retry-controller.ts`. AgentSession holds
one as `#retry` and delegates `abortRetry` / `isRetrying` / `retryAttempt`
through it. Designed with type-only imports so unit tests run without the
native addon.

**StreamingEditGuard**:
Third extracted subsystem (#1b). Watches mid-stream `edit` tool calls and
aborts the agent early when the partial diff already proves the patch will
fail (auto-generated file, removed lines that don't exist in the target,
malformed diff). Aborting mid-stream saves the round-trip cost of waiting
for a doomed tool call. Owns 5 state fields (the per-turn caches, line-count
tracking, last-tool-call-id) plus the pre-cache + abort + invalidate methods.
Lives in `packages/coding-agent/src/session/streaming-edit-guard.ts`.
AgentSession holds one as `#streamingEditGuard`; the assistant-message-event
interceptor calls `preCache()` / `maybeAbort()`, `turn_start` calls `reset()`,
and `tool_execution_end` for "edit" calls `invalidateForPath()`.

**BashController**:
Fourth extracted subsystem (#1b). Owns the per-session "user-initiated bash
command" cluster: a set of in-flight abort controllers, a queue of bash
messages produced during streaming (deferred so they don't break
tool_use/tool_result ordering), and the flush-on-next-prompt logic. Public
API mirrors AgentSession's prior surface: `execute`, `recordResult`, `abort`,
`isRunning`, `hasPending`, `flushPending`. Lives in
`packages/coding-agent/src/session/bash-controller.ts`. AgentSession holds
one as `#bash` and exposes `executeBash` / `recordBashResult` / `abortBash`
/ `isBashRunning` / `hasPendingBashMessages` as thin delegators so external
callers (modes, RPC) don't need to change.

**PythonController**:
Sibling of `BashController` for user-initiated Python execution. Adds the
extra concerns of (1) tracking active executions (so `dispose()` can wait
and abort cooperatively) and (2) per-session kernel ownership for
`disposeKernelSessionsByOwner`. Public API: `execute`, `track`,
`recordResult`, `abort`, `isRunning`, `hasPending`, `flushPending`,
`assertAllowed`, `markDisposing`, `prepareForDispose`, `disposeKernel`.
Lives in `packages/coding-agent/src/session/python-controller.ts`.

**BackgroundExchangeQueue**:
Smallest extracted subsystem (#1b). Owns the queue of "background-channel
IRC exchanges" that arrived while the recipient was streaming. Each batch
(incoming message ± auto-reply) is held until the session goes idle, then
emitted via `emitMessageEvent` so listeners append to history and persist.
Lives in `packages/coding-agent/src/session/background-exchange-queue.ts`.
The IRC orchestrators (`respondAsBackground`, `runEphemeralTurn`) stay on
AgentSession because they cross-cut with `/btw` and the agent registry.

**PlanModeController**:
Owns the plan-mode state cluster (state, reference-sent flag, reference
path) and builds the two plan-mode custom messages
(`plan-mode-context`, `plan-mode-reference`) that get injected into the
conversation. Public API: `getState` / `setState`, `markReferenceSent`,
`setReferencePath`, `isEnabled`, `reset`, `buildReferenceMessage`,
`buildActiveMessage`. Lives in
`packages/coding-agent/src/session/plan-mode-controller.ts`. The
orchestrators that _consume_ plan-mode state (`sendPlanModeContext`, the
tool-decision enforcer) stay on AgentSession because they call `prompt()`
and `sendCustomMessage`.

**ProviderSessionPool**:
Owns the per-session map of provider-side transport state (the
`ProviderSessionState` instances providers stash to persist long-lived state
across turns — e.g. OpenAI Codex Responses' `previous_response_id` chain).
Encapsulates the close-by-reason patterns: `closeAll(reason)` on dispose /
new session / session switch, `closeForModelSwitch(current, next)` on model
change, `closeForCodexHistoryRewrite(current)` on compaction / history
rewrite. The `state` map is shared with `Agent.providerSessionState` so
providers read/write it directly. Lives in
`packages/coding-agent/src/session/provider-session-pool.ts`.

**MCPSelectionStore**:
Owns the per-session MCP-discovery state cluster: which discoverable MCP
tools exist, which subset is selected for the current session, the seed
defaults from config (per-tool ∪ per-server), the per-session-file remembered
defaults used when restoring sessions. Public API: `isEnabled`,
`getDiscoverableTools`, `getSearchIndex`, `getSelectedToolNames`,
`setDiscoverableFromRegistry`, `pruneSelected`, `setSelectedFromActive`,
`getConfiguredDefaults`, `getSelectableExplicitDefaults`,
`unionSelectedWithConfiguredDefaults`, `rememberSessionDefault`,
`getSessionDefault`, `persistIfChanged`, `selectionsMatch`,
`filterSelectable`, `collectActivatable`, `getSelectedSnapshot`,
`captureSelectedSnapshot`, `restoreSelectedSnapshot`. Active-tool management
(`setActiveToolsByName`, `#applyActiveToolsByName`) stays on AgentSession
because it crosses concerns (system prompt rebuild, Auto-QA tool injection,
agent-state mutation) — it _uses_ this store to read/write the MCP-specific
projection. Lives in
`packages/coding-agent/src/session/mcp-selection-store.ts`.

**runCompactionWithRetry**:
A pure function (not a class) extracted from the auto-compaction
orchestrator's per-candidate retry loop. Runs an attempt with transient-error
retry, exponential backoff, and respect for `Retry-After` headers parsed
from the error string. Bails to "next candidate" when delay exceeds
`maxAcceptableDelayMs` (default 30s) and another candidate is available.
Lives in `packages/coding-agent/src/session/compaction-retry.ts`.

The compaction orchestrator itself (`#runAutoCompaction`, `#checkCompaction`,
`#tryContextPromotion`, `#getCompactionModelCandidates`, `#pruneToolOutputs`,
`compact()` from `./compaction`) intentionally stays on AgentSession — it
has 12+ session-callback dependencies (handoff, schedulePostPromptTask,
emitSessionEvent, scheduleAutoContinuePrompt, scheduleAgentContinue,
syncTodoPhasesFromBranch, providerSessions.closeForCodexHistoryRewrite,
buildDisplaySessionContext, modelRegistry, sessionManager, agent state
mutation, extension hooks) and a feedback loop into agent.continue. Risk vs
reward made full extraction unwise this turn.

**pi-tui (legacy frontend, scheduled for deletion — candidate #3)**:
The in-process TUI library at `packages/tui/`. Originally hosted both the
TUI rendering primitives (Text, Container, Box, Loader, Markdown,
SelectList, ...) AND a grab-bag of text-display utilities (`visibleWidth`,
`truncateToWidth`, `padding`, `replaceTabs`, `wrapTextWithAnsi`).

**Architectural intent**: tui-go is the frontend; pi-tui is being deleted.
The migration is scoped across multiple turns (candidate #3 design at
`.claude/plans/delete-pi-tui-design.md`):

- **Decision A** (locked): `omp` (no args, TTY) auto-spawns tui-go and
  pipes RPC. Self-contained UX preserved.
- **Decision B** (locked): print-mode survives, gets refactored off pi-tui.
- **Decision C** (locked): hybrid — tools eventually emit structured
  summaries (consumed by tui-go) AND keep ANSI fallback. Migration is
  per-tool over time.
- **Decision D**: D-3 (small first move) executed; D-1 strategy
  (top-down, frontend first then deletion) for future turns.

**T1 — auto-spawn tui-go (landed)**:
`omp` (no args, TTY) checks the `OMP_TUI` env var. With `OMP_TUI=go` it
spawns `gmp-tui-go` (or `tui-go`) as a subprocess and waits; tui-go itself
spawns `omp --mode rpc` as ITS child. The original omp process becomes a
thin parent that returns the tui-go exit code. With `OMP_TUI=go-strict`
it errors out instead of falling back. Without the env var, behavior is
unchanged — legacy in-process TUI still runs. Override binary path via
`OMP_TUI_BIN`. Implementation at
[packages/coding-agent/src/main.ts:tryAutoSpawnTuiGo](packages/coding-agent/src/main.ts).
Three processes for one session is wasteful; T2+ may optimize to direct
stdio handoff. T_final removes the legacy fallback entirely.

**Migration policy for new code**:

- Don't import from `@oh-my-pi/pi-tui` for code that isn't legacy
  frontend (i.e., not in `modes/components/*`, `modes/controllers/*`,
  `modes/interactive-mode.ts`, `modes/theme/*`, `tools/renderers.ts`).
- Use `@oh-my-pi/pi-utils` for text-width / truncation / padding /
  tab-handling. The text utilities (`visibleWidth`, `padding`,
  `replaceTabs`) were moved out of pi-tui in D-3.
  (`truncateToWidth`, `wrapTextWithAnsi`, `Ellipsis` stay in pi-tui
  because they're native-addon-coupled.)
- Use `@oh-my-pi/pi-utils` for `getTerminalId` / `getTtyPath` (T2 phase).
- pi-tui still re-exports the moved names for backward compat with the
  ~150 existing consumer files that haven't migrated yet.
- For CLI session pickers / debug UIs / autoresearch dashboards, the
  long-term plan is to move them to tui-go via RPC; do not add new
  pi-tui-driven UI without a plan.

**T2 — non-frontend pi-tui migrations (in progress)**:
Target: extract pi-tui consumers that aren't legacy-frontend code.
Done so far:

- `getTerminalId` / `getTtyPath` → pi-utils (was in pi-tui's `ttyid.ts`)
- `session-manager.ts` migrated to import `getTerminalId` from pi-utils
- `edit/renderer-helpers.ts` migrated `visibleWidth` import to pi-utils
- `edit/normalize.ts` migrated `padding` import to pi-utils (D-3 POC)
  Pending: `commit/agentic/agent.ts` (Markdown), extensibility type-only
  imports, autoresearch tools, debug viewer, session-picker.

**OMP-RPC v1** (the wire vocabulary between `omp --mode rpc` and tui-go):
The frozen JSON-Lines protocol exchanged between the omp coding-agent
server and host frontends. 10 event variants mirror pi-agent-core's
`AgentEvent` (narrowed to fields tui-go consumes). The 10 coding-agent
session extensions (`auto_compaction_*`, `auto_retry_*`,
`retry_fallback_*`, `ttsr_triggered`, `todo_*`, `irc_message`) are
**internal-only** — translated to `null` and dropped at the wire
chokepoint.

Architecture:

- **Schema**: `omp-rpc/v1` declared on the `ready` frame at startup.
  Hosts SHOULD verify (soft buffer on mismatch — preserve unknown frames
  as raw, don't crash).
- **Translator** at [`wire/translate.ts`](packages/coding-agent/src/modes/rpc/wire/translate.ts) —
  exhaustive `switch` over `AgentSessionEvent`. Failing to handle a new
  internal variant is a TypeScript compile error, not a silent leak.
- **Chokepoint** at [`rpc-mode.ts`](packages/coding-agent/src/modes/rpc/rpc-mode.ts):
  the `output(frame: WireFrame)` callback is the only path to stdout for
  v1 frames. Type system enforces that only `WireFrame`-shaped objects
  flow through.
- **Spec**: hand-written at [`wire/README.md`](packages/coding-agent/src/modes/rpc/wire/README.md).
  Source of truth for downstream frontend implementers.
- **Versioning rules**: additive evolution within v1 (new optional
  fields, new variant types). Renames or removals require a major bump
  to v2.
- **Migration model**: hard-cut. No dual-emit. v1 ships as a coordinated
  TS+Go release.

Commands (host → server) ARE the v1 surface — documented in
[`rpc-types.ts`](packages/coding-agent/src/modes/rpc/rpc-types.ts) by
reference, not translated. Decision 5C: skip translator for inbound;
freeze names; additive evolution applies.

**RequestCorrelator**:
Shared id-correlated request/response primitive at
[`request-correlator.ts`](packages/coding-agent/src/modes/rpc/request-correlator.ts).
Replaces two bespoke `Map<id, {resolve, reject}>` patterns (extension UI
dialogs + host tool calls) with one tested implementation. Wire shape
is unchanged — frame names stay distinct on the wire (decision 8,
interpretation B); only the correlation logic is shared.

**Auth storage** (canonical owner: pi-ai):
Credential persistence (`AuthCredentialStore`, SQLite-backed at `agent.db`),
runtime resolution (`AuthStorage` — caches credentials, ranks them per
provider, refreshes OAuth, tracks usage limits), provider-specific OAuth
flows (`utils/oauth/{kagi,kimi,minimax,openai-codex,parallel,tavily,zai}`),
and the auth resolver pipeline live in **pi-ai**. This is intentional:
pi-ai ships its own CLI binary (`pi-ai login`) and the OAuth flows are
inseparable from provider integrations.

coding-agent imports `AuthStorage` directly from `@oh-my-pi/pi-ai`. The
`coding-agent/src/index.ts` barrel re-exports `AuthStorage` and the
credential types so downstream packages (swarm-extension,
typescript-edit-benchmark, SDK examples) can import them via
`@oh-my-pi/pi-coding-agent`.

The previous `coding-agent/src/session/auth-storage.ts` re-export shim was
removed as a vestigial migration artifact (CHANGELOG note from when the
implementation lived in coding-agent before being moved to pi-ai).

Note on the misplaced-seam framing: candidate #5 originally proposed moving
`AuthStorage` into coding-agent because "only coding-agent uses it". On
closer reading the framing is over-stated — pi-ai's CLI uses
`AuthCredentialStore` standalone, OAuth providers are inseparable from
provider integrations, and `AuthStorage.getApiKey(...)` is exactly the
clean resolver seam that lets coding-agent stay agnostic to storage
details. Resolved: keep auth in pi-ai; only the cleanup (vestigial shim
removal) was warranted.

**ThinkingLevel** (canonical owner: pi-agent-core):
The session-level thinking selector. Wider than pi-ai's `Effort` — adds
`"off"` (no reasoning) and `"inherit"` (defer to parent session).
`ResolvedThinkingLevel` is the same union minus `"inherit"` (what survives
once a session has been resolved).

The full thinking taxonomy now has one owner per layer:

- **pi-ai/model-thinking.ts** — provider data + clamping: `Effort`,
  `THINKING_EFFORTS`, `ThinkingConfig`, `clampThinkingLevelForModel`,
  `getSupportedEfforts`, `requireSupportedEffort`, `enrichModelThinking`.
- **pi-agent-core/thinking.ts** — session-level resolution: `ThinkingLevel`,
  `ResolvedThinkingLevel`, `parseThinkingLevel`, `toReasoningEffort`,
  `resolveThinkingLevelForModel`. Calls into pi-ai for the model clamping
  primitive.
- **coding-agent/thinking.ts** — UI presentation: `ThinkingLevelMetadata`,
  `getThinkingLevelMetadata`, `parseEffort` (CLI-input parsing). Re-exports
  the pi-agent-core surface so `import { ThinkingLevel } from "../thinking"`
  inside coding-agent keeps working.

Before this consolidation, pi-agent-core's thinking.ts was a 19-line
passthrough — type aliases only, no implementation. coding-agent owned the
resolution logic. The deletion test on the old pi-agent-core file passed
(it concentrated complexity rather than spreading it). After consolidation:
each package has implementation it actually uses.

**TtsrEngine**:
Owns the per-session TTSR (test-time self-rewrite) state cluster:

- `manager`: TtsrManager (rule store + delta-checker)
- `pending`: queued rules for next injection
- `abortPending`: flag the message_update handler flips when aborting
- `retryToken`: monotonic counter used to invalidate stale post-prompt retries
- resume promise gate (callers like `prompt()` and `#waitForPostPromptRecovery` await on it)

Owns the pure helpers — `addRules`, `consume`, `markInjected`,
`extractRuleNamesFromDetails`, `findAssistantIndex`, `shouldInterruptForMatch`,
`getToolMatchContext` (with internal `extractFilePathsFromArgs` +
`normalizePathCandidates`). Lives in
`packages/coding-agent/src/session/ttsr-engine.ts`.

The dense `message_update` handler with `agent.abort()` + scheduled
`agent.continue()` retry stays inline on AgentSession, as does
`#queueDeferredTtsrInjectionIfNeeded` (which calls `agent.followUp` +
`#scheduleAgentContinue`). Those carry cross-event coordination this seam
intentionally does not encapsulate — extracting them would require a thick
context interface (agent.abort/continue/followUp/replaceMessages/appendMessage,
sessionManager.appendCustomMessageEntry, schedulePostPromptTask,
scheduleAgentContinue, emitSessionEvent, promptGeneration getter) and a
feedback loop into the agent loop with high regression risk. Save for a
grilling round.

**Reactor** _(target shape for #1b)_:
The decomposed `AgentSession` where the central class shrinks to a state
struct + facade methods + an event router, and each subsystem (TtsrEngine,
RetryPolicy, Compactor, ActiveRetryFallback, …) is a self-contained
controller. Some subsystems will subscribe to `AgentEvent` directly via
`subscribe()`; others (like `ActiveRetryFallback`) are stateful controllers
that AgentSession calls at known hook points. Hybrid by design — pure
event-bus is over-rigid for subsystems that need to mutate session state.

**GmpWorkspace** (canonical owner: apps/tui-go):
The `Workspace` implementation that backs `gmp-tui-go` against an `omp
--mode rpc` subprocess. Lives in
`apps/tui-go/internal/workspace/gmp_workspace.go`. Owns the JSONL stdio
bridge, message translation, the auth.\* extension UI dispatcher
(`dispatchExtensionUIRequest`, `translateAuthRequest`, `HandleAuthReply`),
and `SendAuthCommand` for outbound `/login` / `/logout`.

**Backend Model Catalog/AuthStorage**:
The canonical model and credential source for gmp bridge mode. Lives in
`packages/coding-agent` as `ModelRegistry` plus its `AuthStorage`; exposed
to tui-go over RPC through `models.catalog`, `set_model`, and `auth.*`.
All gmp model availability, login state, and role selection state must come
from this pair.

**Bridge Model Catalog** _(adapter — to be deleted as picker migrates to direct `RpcModelCatalog` consumption; see ADR 0002)_:
The Go-side, render-only projection of `Backend Model Catalog/AuthStorage`
inside `GmpWorkspace`. `RefreshModelCatalog` calls `models.catalog`,
rebuilds `cfg.Providers` with real backend providers/models, and marks
unavailable entries for `GmpAuth` login/retry. It exists only to satisfy
the inherited Crush picker's `cfg.Providers` shape (catwalk's data
structure); it is not a separate source of truth and will be removed when
the picker is rewritten to consume `RpcModelCatalog` directly.

**Synthetic gmp provider** _(adapter scaffolding — same lifecycle as Bridge Model Catalog)_:
The fallback `ProviderConfig` `GmpWorkspace.newOmpConfig` injects before
the first backend catalog refresh. ID `"gmp"` (exported as
`workspace.GmpProviderID`), single model `"gmp-backend"` displayed as
"gmp backend". Normal gmp runtime must replace it with the Bridge Model
Catalog before opening the model picker; it is not a real selectable
catalog entry. Disappears with the Bridge Model Catalog adapter — once
the picker reads `RpcModelCatalog` directly there is nothing to
pre-populate.

**Legacy Crush Catalog** _(out of `apps/tui-go` scope after Phase 1 lite)_:
The Catwalk/Crush provider catalog and `crush.json` config path. After
Phase 1 lite (ADR 0002), `apps/tui-go` is gmp-only and never reads
this catalog as live runtime state — it remains as the upstream Crush
on-disk format that vanilla `crush` (a separate binary) consumes, and
as input for one-time `models.yml` imports on the backend side.

**IsGmpMode() bool** _(scheduled for collapse in carve-out Phase 1 lite — see ADR 0002)_:
The `Workspace`-interface discriminator that gates every gmp-specific
branch in the TUI: picker scope (`internal/ui/dialog/models.go`), auth
dialog routing (`openAuthenticationDialog` →
`runGmpAuthCommand`), and `gmp-tui-go login` (one-shot RPC driver).
`*GmpWorkspace` returns `true`; `*AppWorkspace` and `*ClientWorkspace`
return `false`. Decoupled from `Options.DisableDefaultProviders` —
that flag also suppresses the catwalk catalog but does not imply gmp
ownership.

After Phase 1 lite lands, `*AppWorkspace` and `*ClientWorkspace` are
deleted, `setupAppWorkspace` / `setupClientServerWorkspace` go with
them (already-unreachable from any cobra path), and `IsGmpMode()`
collapses to a constant `true`. The discriminator pattern survives
this turn only because deleting it touches every consumer site;
removal is a follow-up sweep.

**GmpAuth dialog** _(Bubble Tea)_:
`apps/tui-go/internal/ui/dialog/gmp_auth.go`. Consumes the auth.\*
`tea.Msg` types defined in `internal/auth/messages.go` (`ShowLoginURL`,
`ShowProgress`, `PromptCode`, `PromptManualRedirect`, `PickProvider`,
`ShowResult`) and emits `Submit` / `Confirm` / `Cancel` replies that
`GmpWorkspace.HandleAuthReply` converts back into
`extension_ui_response` wire frames. Distinct from
`dialog.NewAPIKeyInput` / `dialog.NewOAuthHyper` — those terminate by
writing Crush local config, which is wrong in gmp mode.

**RpcOAuthController** (canonical owner: pi-coding-agent):
The TS-side `OAuthController` implementation at
`packages/coding-agent/src/modes/rpc/rpc-oauth-controller.ts`. Used
by every gmp provider integration when running under
`omp --mode rpc`. Each callback (`onAuth`, `onProgress`, `onPrompt`,
`onManualCodeInput`, `emitResult`) emits a
method-discriminated `extension_ui_request` frame; correlated awaits
go through `RequestCorrelator`. The Go-side `apps/tui-go` workspace
dispatcher (`GmpWorkspace.dispatchExtensionUIRequest`) routes those
frames to the Bubble Tea `GmpAuth` dialog and ferries the responses
back as `extension_ui_response` frames.

The auth._ wire shape is type-locked on both sides: TS callers go
through the derived `AuthRequestPayload` union (extracted from
`RpcExtensionUIRequest` and stripped of `type`/`id`), and the Go
dispatcher runs an init-time parity check that every `auth.MethodX`
constant has an entry in `authDecoders`. Adding a new auth._ method
is a TypeScript compile error until the wire union is extended, and
a Go startup panic until the per-method payload struct + decoder
entry exist. This mirrors the compile-time guarantee that
`wire/translate.ts` already gives `AgentSessionEvent`. The contract
tests are at `rpc-oauth-controller.test.ts` (TS-side per-`AuthMethod`
shape table + `@ts-expect-error` block) and
`gmp_workspace_auth_test.go` (`TestAuthDecoderParity` over the const
list + `TestAuthDecoderInitPanicsOnMissing`). Deleting either test
makes the seam bypassable, which is the deletion-test bar this
deepening was designed to pass.

**authCLIDriver** _(`gmp-tui-go login`)_:
The shell-friendly counterpart to `GmpAuth`, in
`apps/tui-go/internal/cmd/login.go`. Spawns a one-shot
`omp --mode rpc` subprocess, sends `auth.login <provider>`, and walks
the resulting `auth.*` frames as `Println` / `fmt.Scanln` prompts.
Same wire contract as the TUI, separate UX. Both terminate by
returning the gmp-side `auth.show_result`.

**Provider-required contract** _(see ADR 0002)_: `auth.login` requires a
non-empty `provider` field on the wire. The Go `Command.Provider`
JSON tag must drop `omitempty` for this command, and the backend
returns a typed error if `provider` is missing. When the user invokes
`gmp-tui-go login` with no argument, the picker is driven by a
correlated `auth.pick_provider` extension_ui_request emitted by the
backend before AuthStorage.login is called — the picker frame and
its routing already exist on both sides; only the emit-when-empty
branch was missing. The TUI's `/login` slash command takes the same
wire path: provider required, picker via extension_ui_request when
the user types `/login` bare.

**Runtime mode** _(post-ADR 0002)_:
`apps/tui-go` is gmp-only. `setupWorkspace()` always returns
`*GmpWorkspace`; the unreachable `setupAppWorkspace` /
`setupClientServerWorkspace` branches are deleted along with
`AppWorkspace` (393 LOC), `ClientWorkspace` (777 LOC), the legacy
auth dialogs (`api_key_input.go`, `oauth_hyper.go`,
`oauth_copilot.go`), and the legacy CLI commands they back
(`cmd/login.go` is replaced with a thin RPC-only shell, `cmd/oauth.go`
deleted). `gmp-tui-go run` (non-interactive prompt mode) is rewritten
to use the gmp RPC backend rather than `setupLocalWorkspace`. The full
carve-out (Phase 1 in `apps/tui-go/docs/carve-out-plan.md` —
`internal/{backend,server,client,db,swagger}` deletion + the type-
surface work in Phase 2) remains the north star; Phase 1 lite is the
bounded next step that sheds the obviously-unreachable code without
touching the type surface the UI shares with Crush internals.

## Relationships

- An **AgentEvent** of type `agent_end` or `message_end` carries an optional
  **AgentErrorKind** when its assistant message has `stopReason === "error"`.
- The **AgentErrorKind** is computed once at the emission boundary
  (pi-agent-core) and consumed by all retry/compaction subsystems via the
  event stream — never by re-parsing `errorMessage`. The auto-compaction
  retry path that catches a thrown `Error` (no `AgentEvent`) is the one
  documented exception and uses the lower-level pi-ai classifiers directly.
- An **AgentSession** subscribes to `AgentEvent`s and routes them to its
  internal subsystems. After candidate #1b lands, those subsystems become
  independent subscribers in the **Reactor** model.

## Example dialogue

> **Dev:** "How do we tell rate-limit from context overflow now?"
> **Architect:** "Read `event.errorKind` — pi-agent-core classifies once at
> emission. Don't re-parse `errorMessage`."

> **Dev:** "What about the auto-compaction retry path that catches `Error`?"
> **Architect:** "That doesn't go through `AgentEvent`, so it stays on
> `parseRetryAfterMsFromString` / `isTransientErrorMessage` / `isUsageLimitError`
> from pi-ai. Documented exception."
