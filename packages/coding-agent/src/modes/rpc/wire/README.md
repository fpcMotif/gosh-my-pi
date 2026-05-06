# OMP-RPC v1 — Wire Protocol Specification

**Schema version:** `omp-rpc/v1`
**Transport:** JSON Lines over stdin/stdout (one frame per line, UTF-8)
**Status:** Frozen. Additive evolution only within v1.

This document is the source of truth for the wire vocabulary exchanged
between `omp --mode rpc` (the server) and any consumer (today: `apps/tui-go`,
tomorrow potentially web/IDE frontends).

The TypeScript type contract lives in [`v1.ts`](v1.ts). The translator
function that produces v1 frames from internal session events lives in
[`translate.ts`](translate.ts). Tests in [`translate.test.ts`](translate.test.ts)
enforce the contract.

## Frame envelope

Every line on stdout is one JSON object with a `type` discriminator:

| `type` | Direction | Description |
|---|---|---|
| `ready` | server → host | One-shot handshake on session startup. Carries `schema` field with version marker. |
| `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | server → host | Streaming agent events. See [event vocabulary](#event-vocabulary) below. |
| `response` | server → host | Reply to a host-issued command (id-correlated via `id` field). |
| `extension_ui_request` | server → host | Server asks host for user-interaction (id-correlated). |
| `host_tool_call` | server → host | Server asks host to execute a registered tool (id-correlated). |
| `host_tool_cancel` | server → host | Server cancels a pending host tool call. |
| (commands) | host → server | See [command vocabulary](#command-vocabulary) below. |
| `extension_ui_response` | host → server | Reply to `extension_ui_request`. |
| `host_tool_update` | host → server | Streaming partial result for an in-flight host tool call. |
| `host_tool_result` | host → server | Final result for a host tool call. |

## Handshake

On startup, the server emits exactly one `ready` frame:

```json
{"type":"ready","schema":"omp-rpc/v1"}
```

Hosts SHOULD verify `schema === "omp-rpc/v1"` and refuse or warn on
mismatch. A server that doesn't emit `schema` is a pre-v1 server (don't
support back-compat — coordinate the upgrade).

## Event vocabulary

Ten event types ship in v1 — they mirror pi-agent-core's `AgentEvent`
union, narrowed to fields tui-go consumes today.

### `agent_start`

Emitted at the start of a prompt cycle. No payload.

```json
{"type":"agent_start"}
```

### `agent_end`

Emitted when the prompt cycle terminates (success, abort, or error).

```typescript
{
  type: "agent_end",
  messages: WireMessageV1[],   // all new messages produced this run
  errorKind?: WireErrorKindV1, // present when last assistant message has stopReason "error"
}
```

`errorKind` is the typed retry classification added in #1a:
- `{kind: "context_overflow", usedTokens?: number}`
- `{kind: "usage_limit", retryAfterMs: number}`
- `{kind: "transient", retryAfterMs?: number, reason?: TransientReason}`
- `{kind: "fatal"}`

### `turn_start` / `turn_end`

A "turn" is one assistant response + tool calls/results. `turn_end`
carries the assistant message + any tool results from the turn.

```typescript
{type: "turn_start"}
{type: "turn_end", message: WireMessageV1, toolResults: WireToolResultMessageV1[]}
```

### `message_start` / `message_update` / `message_end`

Per-message lifecycle. `message_update` only fires for assistant messages
during streaming and carries the inner `assistantMessageEvent` (text/thinking
delta, tool-call delta, etc.).

```typescript
{type: "message_start", message: WireMessageV1}
{type: "message_update", message: WireMessageV1, assistantMessageEvent: WireAssistantMessageEventV1}
{type: "message_end", message: WireMessageV1, errorKind?: WireErrorKindV1}
```

### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

Tool invocation lifecycle. `update` events carry partial results for
streaming tools; `end` carries the final result.

```typescript
{type: "tool_execution_start", toolCallId: string, toolName: string, args: object, intent?: string}
{type: "tool_execution_update", toolCallId: string, toolName: string, args: object, partialResult: WireToolResultV1}
{type: "tool_execution_end", toolCallId: string, toolName: string, result: WireToolResultV1, isError?: boolean}
```

## Message shapes

`WireMessageV1` is a discriminated union by `role`:

| `role` | Description |
|---|---|
| `user` | User-authored prompt |
| `developer` | Developer/system message (rare) |
| `assistant` | Model-produced response with content blocks |
| `toolResult` | Result of a tool invocation |
| `bashExecution` | User-initiated bash command (`!cmd` syntax) |
| `pythonExecution` | User-initiated Python (`$cmd` syntax) |
| `custom` | Extension-injected message |
| `hookMessage` | Legacy hook-system message |

See [`v1.ts`](v1.ts) for exact field definitions per role.

## Command vocabulary

Commands sent host → server are documented in
[`../rpc-types.ts`](../rpc-types.ts) as the `RpcCommand` union. Per
[design decision 5C](../../../../../../.claude/plans/rpc-schema-versioning-design.md),
commands ARE the v1 surface — no separate translator. Adding a command
variant is additive evolution within v1; renaming or removing requires
a major bump.

The command set covers:
- Prompting: `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session`
- State queries: `get_state`, `set_todos`, `set_host_tools`
- Model: `set_model`, `cycle_model`, `get_available_models`
- Thinking: `set_thinking_level`, `cycle_thinking_level`
- Queue modes: `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`
- Compaction: `compact`, `set_auto_compaction`
- Retry: `set_auto_retry`, `abort_retry`
- Bash: `bash`, `abort_bash`
- Session: `get_session_stats`, `export_html`, `switch_session`, `branch`,
  `get_branch_messages`, `get_last_assistant_text`, `set_session_name`
- Messages: `get_messages`

Every command MAY carry an optional `id` field; the matching `response`
frame echoes the `id` for correlation.

## Versioning rules

### Within `omp-rpc/v1` (additive only)

Allowed without major bump:
- Adding new optional fields to existing event/command/message variants
- Adding new event variants (e.g., a future `auto_compaction_start` reaches v1)
- Adding new command variants
- Adding new optional content block types

NOT allowed within v1:
- Renaming any existing field or variant
- Removing any field or variant
- Changing a required field to a different type
- Reordering content blocks or breaking discriminator semantics

### Major bump (`omp-rpc/v2`)

Required when:
- Existing event type names change (e.g., `message_update` → `assistant_delta`)
- Frame envelope shape changes (e.g., adding `version` per-frame)
- A required field becomes optional or vice versa with semantic change

Major bumps are coordinated TS+Go releases — no dual-emit transition.

## Unknown event handling

Hosts encountering an unknown `type` value SHOULD soft-buffer the frame
(preserve it as raw JSON, do not crash). Today's `tui-go` already does
this — see [`apps/tui-go/internal/ompclient/types.go`](../../../../../../apps/tui-go/internal/ompclient/types.go)
`Frame.Raw json.RawMessage`.

This lets the server roll out additive evolution without breaking older
hosts; the worst case is the host doesn't render the new event.

## Internal-only events (NOT on the wire)

These pi-coding-agent session events are emitted internally to extension
hooks and in-process subscribers but are translated to `null` and dropped
at the wire chokepoint:

- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `ttsr_triggered`
- `todo_reminder`, `todo_auto_clear`
- `irc_message`

If a future feature needs one of these on the wire, additive evolution
adds it to `WireEventV1` and `toWireEvent`.

## Implementation guarantees

The translator's `switch` statement in [`translate.ts`](translate.ts) is
**exhaustive** — TypeScript enforces that every `AgentSessionEvent` variant
is handled. Forgetting a new variant is a compile-time error, not a
silent leak.

Tests in [`translate.test.ts`](translate.test.ts) verify:
- All 10 v1 event types translate correctly with stable shapes
- All 10 internal-only events return `null`
- `errorKind` is preserved end-to-end (the #1a contract)
- Optional fields are omitted (not emitted as `undefined`)

## References

- Design discussion: [`rpc-schema-versioning-design.md`](../../../../../../.claude/plans/rpc-schema-versioning-design.md)
- Implementation plan: [`rpc-v1-implementation.md`](../../../../../../.claude/plans/rpc-v1-implementation.md)
- TypeScript types: [`v1.ts`](v1.ts)
- Translator: [`translate.ts`](translate.ts)
- Tests: [`translate.test.ts`](translate.test.ts)
- Go-side mirror: [`apps/tui-go/internal/ompclient/types.go`](../../../../../../apps/tui-go/internal/ompclient/types.go)
