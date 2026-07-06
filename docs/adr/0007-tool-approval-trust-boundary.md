# ADR 0007: Tool approval is a host trust boundary, not in-process state

## Status

Accepted — 2026-06-01.

## Context

The agent runtime (`packages/agent/src/agent-loop/`) executes every tool
call unconditionally. `executeSingleToolCall` resolves the tool by name
and runs `tool.execute(...)` with no gate. That is correct for the
in-process embedding (`packages/coding-agent` drives the runtime
directly and already owns the tools it registers), but it is a gap for
OMP-RPC bridge mode (`omp --mode rpc`, consumed by `apps/tui-go`).

In bridge mode the host (`apps/tui-go`) is a separate process that
cannot see or veto what the backend agent does to the user's machine.
Destructive built-in tools — `bash`, `edit`, `apply_patch`, `write` —
run to completion before the host learns they happened. The Go side
already ships a `dialog.Permissions` component (`internal/ui/dialog/
permissions.go`) with per-tool `Params` types (`BashPermissionsParams`,
`EditPermissionsParams`, `WritePermissionsParams`, …), but it is
orphaned: no wire frame ever feeds it. The legacy Crush
`permission.Service` it was built for is an inert no-op stub on
`GmpWorkspace` (`PermissionGrant`/`PermissionDeny` do nothing — see
ADR 0001/0002, which make Backend AuthStorage the single source of truth
and keep Crush's in-process stores inert in gmp mode).

Reviving the Crush in-process permission service to close this gap would
violate ADR 0001 and ADR 0002: it reintroduces a second source of truth
that the backend never consults, and couples runtime tool execution to
host-resident UI state. The runtime must stay host-agnostic — it has no
business knowing which host is attached or what that host's approval
policy is.

## Decision

Gate destructive built-in tools (`bash`, `edit`, `apply_patch`, `write`)
behind an **additive OMP-RPC v1 approval round-trip** carried on the
existing correlated `extension_ui_request` / `extension_ui_response`
channel — exactly like the `auth.*` flow (ADR 0001). Read-only and
search tools auto-approve with no round-trip. The runtime stays
host-agnostic via an **optional callback**; there is no in-process
permission state.

### Runtime seam (host-agnostic)

`AgentLoopConfig` (and `AgentOptions`) gain one optional hook:

```typescript
requestToolApproval?: (toolCall: ToolCall) => Promise<{ approved: boolean; reason?: string }>;
```

`executeSingleToolCall` calls it once, after the tool is resolved and
`tool_execution_start` is emitted, but **before** `tool.execute(...)`.

- When the hook is **absent**, behavior is byte-for-byte what it is
  today — no gate, no extra event, full backward compatibility. Every
  existing test passes unchanged.
- When the hook returns `approved: true`, execution proceeds normally.
- When the hook returns `approved: false`, the tool does **not**
  execute. The runtime emits the same `isError` `tool_execution_end`
  shape it already uses for tool errors, with text `Denied by user`
  (plus the optional `reason`). The deny is just another tool result
  the model sees on the next turn — no new event variant, no thrown
  error.

The runtime calls the hook for **every** tool when present. The
**policy** of which tools require approval lives entirely in the hook,
not in the runtime. This keeps the trust boundary where it belongs (the
host's bridge controller) and keeps the runtime ignorant of tool
semantics.

### RPC mode policy (the host-agnostic hook's gmp implementation)

`packages/coding-agent/src/modes/rpc/` provides the callback when driving
the session under `omp --mode rpc` (`RpcToolApprovalController`,
modeled on `RpcOAuthController`):

- Tools in the destructive set (`bash`, `edit`, `apply_patch`, `write`)
  → emit a correlated `extension_ui_request` with method
  `tool.request_approval` and await the `extension_ui_response`.
- Every other tool → return `{ approved: true }` immediately, no
  round-trip.
- The response decision maps: a non-empty `value`/`confirmed:true`
  → `{ approved: true }`; `cancelled`/`confirmed:false`
  → `{ approved: false }`. Gate-by-default: a cancelled or timed-out
  dialog denies rather than silently allowing.

### Wire (additive only)

`RpcExtensionUIRequest` gains one variant — method
`tool.request_approval`, payload `{ toolCallId, toolName, params,
summary }`. The derived `ToolApprovalRequestPayload` type-locks it the
same way `AuthRequestPayload` type-locks the auth variants. The 10 event
variants and the `WireFrame` envelope are untouched. No new top-level
frame type. This conforms to the CONTEXT.md OMP-RPC v1 "additive only"
rule.

### Go side (route to the existing dialog, reply over the wire)

`apps/tui-go` decodes `tool.request_approval` into a
`toolapproval.Request` Bubble Tea message (mirroring the `auth.*`
decoder/parity machinery). The model opens the **existing**
`dialog.Permissions` component, built from the decoded payload. The
dialog's approve/deny `ActionPermissionResponse` is routed — in gmp mode
only — to `GmpWorkspace.HandleToolApprovalReply`, which sends an
`extension_ui_response` back through the **same path** `HandleAuthReply`
uses. The in-process `permission.Service` stays inert (its
`PermissionGrant`/`Deny` remain no-ops on `GmpWorkspace`). A startup
parity check (mirror of the auth decoder parity check) makes a new
method a startup panic until both the const list and the decoder map
carry it.

## Consequences

- **Trust boundary is explicit and host-owned.** The backend cannot run
  `bash`/`edit`/`apply_patch`/`write` in bridge mode without the host
  granting it. The host decides policy; the runtime only asks.
- **Runtime stays pure.** No host coupling, no permission state, no new
  dependency. Embedders that do not set the hook are unaffected.
- **Deny is a normal tool result.** The model receives an `isError`
  result and can react (explain, pick a different approach) instead of
  crashing the turn.
- **Orphaned dialog is now wired.** `dialog.Permissions` finally has a
  wire feed in gmp mode, reusing its per-tool rendering.
- **Read-only tools stay fast.** Search/read tools never round-trip, so
  the common path adds no latency.
- **No revival of Crush permission state.** ADR 0001/0002 hold: backend
  remains the single source of truth; the host's role is a UI veto over
  the wire, not a second permission store.

## Rejected

- **Gate inside the runtime by hard-coding the destructive tool list.**
  Rejected — couples the runtime to tool semantics and to a specific
  host's policy. The hook keeps the runtime host-agnostic.
- **Revive the Crush in-process `permission.Service`.** Rejected —
  violates ADR 0001/0002 (second source of truth, never consulted by the
  backend) and would couple tool execution to host-resident state.
- **A new top-level wire frame for approvals.** Rejected — the existing
  correlated `extension_ui_request`/`extension_ui_response` channel
  already carries request/response dialogs (auth.*); a new frame would
  break the OMP-RPC v1 additive rule and duplicate the correlator.
- **Throw on deny.** Rejected — a thrown error aborts the turn and loses
  the signal. The existing `isError` tool-result shape lets the model
  recover.

## Implementation pointers

- `packages/agent/src/types.ts` — `requestToolApproval` on
  `AgentLoopConfig` + `AgentOptions`.
- `packages/agent/src/agent.ts` — `setToolApprovalHook` setter +
  `#createLoopConfig` wiring.
- `packages/agent/src/agent-loop/execution.ts` —
  `executeSingleToolCall` gate before `performToolExecution`;
  `createDeniedToolResult`.
- `packages/coding-agent/src/modes/rpc/rpc-tool-approval-controller.ts`
  — the gmp policy + correlated `tool.request_approval` round-trip.
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` —
  `ToolApprovalMethod`, `tool.request_approval` variant,
  `ToolApprovalRequestPayload`.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — attach the
  controller's hook to the session's agent.
- `apps/tui-go/internal/toolapproval/` — Bubble Tea message + method
  constant.
- `apps/tui-go/internal/workspace/gmp_workspace.go` —
  `tool.request_approval` decoder, parity check,
  `HandleToolApprovalReply`.
- `apps/tui-go/internal/ui/model/ui.go` — open `dialog.Permissions`
  from the decoded request; route `ActionPermissionResponse` to the
  wire in gmp mode.

## Out of scope

- Persisting "allow for session" across requests in bridge mode. The
  dialog offers the button; for now `allow_session` maps to a single
  approve. A durable per-session allowlist on the backend is a future
  ADR.
- MCP and host-registered tool approval. This ADR covers the four
  destructive built-ins; the hook is general enough to extend the policy
  later without a runtime change.
