# OMP-RPC v1 — cross-language golden wire fixtures

Each file in this directory is the **exact wire JSON** a real `omp --mode rpc`
backend emits for one representative OMP-RPC v1 frame variant. They are the
single shared source of truth consumed by **both** sides of the bridge:

- **TypeScript (encode parity)** —
  `packages/coding-agent/src/modes/rpc/wire/golden-fixtures.test.ts` builds the
  internal `AgentSessionEvent` for each variant, runs `toWireEvent(...)`, and
  asserts the result deep-equals the fixture. A renamed/added/dropped wire field
  in `translate.ts` or `v1.ts` fails this test.
- **Go (decode parity)** —
  `apps/tui-go/internal/workspace/wire_golden_test.go` reads the same files via a
  relative path and decodes each through the **real** Go bridge path
  (`handleAgentEnd` / `handleMessageEnd` / `handleToolExecutionEnd` /
  `handleMessageUpdate` and the pure helpers `toWireToolResultMetadata`,
  `describeAgentErrorKind`, `mapWireToolName`). A field rename on the Go struct
  side fails this test.

Today both language suites pass independently, so a field rename can silently
break the live bridge while both stay green. These fixtures close that gap
(G23): the same bytes must round-trip through both decoders.

## How both languages read this directory

The fixtures live under `packages/coding-agent`. The Go test reads them with a
relative path from `apps/tui-go/internal/workspace`:

```
../../../../packages/coding-agent/src/modes/rpc/wire/__fixtures__/wire-v1
```

This keeps one checked-in copy (no symlink, no duplication) that both a `bun`
test and a `go test` resolve deterministically.

## Variant list

| File                                 | Variant                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `ready.json`                         | `ready` handshake frame                                  |
| `agent_start.json`                   | `agent_start`                                            |
| `agent_end.json`                     | `agent_end` (no `errorKind`)                             |
| `agent_end.error_kind.json`          | `agent_end` with `errorKind` (`usage_limit`)             |
| `turn_end.json`                      | `turn_end` with message + toolResults                    |
| `message_start.json`                 | `message_start`                                          |
| `message_start.user_correlation.json` | `message_start` for a user message carrying `correlationId` |
| `message_update.text_delta.json`     | `message_update` carrying a `text_delta` sub-event       |
| `message_update.toolcall_end.json`   | `message_update` carrying a `toolcall_end` sub-event     |
| `message_end.error_kind.json`        | `message_end` with `errorKind` (`context_overflow`)      |
| `tool_execution_start.json`          | `tool_execution_start` (bash, with `presentation`)       |
| `tool_execution_update.json`         | `tool_execution_update` (read, with code `presentation`) |
| `tool_execution_end.edit_diff.json`  | `tool_execution_end` for an edit diff (`details.diff`)   |
| `ordering.sequence.jsonl`            | one full ordered prompt cycle (JSONL, one frame/line)    |

## Maintenance rule (mandatory)

**Any additive OMP-RPC v1 change MUST add or update a fixture here in the same
PR.** A new event variant, a new optional field that a host reads, or a new
content-block type that changes the emitted bytes needs a representative fixture
plus the matching assertion on both the TS and Go side. A wire change with no
fixture delta is incomplete: the cross-language guard only protects the shapes
that have a golden frame.

These fixtures are NOT exhaustive — they cover the load-bearing variants. They
are not a substitute for the per-side unit suites (`translate.test.ts`,
`tool_metadata_test.go`, `error_kind_test.go`); they are the cross-language
agreement layer on top of them.
