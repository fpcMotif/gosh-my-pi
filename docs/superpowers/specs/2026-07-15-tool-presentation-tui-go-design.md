# ToolPresentation through tui-go

Status: design approved. Written spec awaiting review.

## Problem

TypeScript already emits optional `ToolPresentation` snapshots on OMP-RPC tool
start, update, and end frames. tui-go ignores them. It reconstructs tool names,
read content, and edit diffs from raw result JSON for legacy Crush renderers.
Presentation knowledge therefore lives in four places: tool presenters, the
wire translator, Go metadata reconstruction, and Go tool renderers.

The wire README also omits the existing `presentation` fields. Go golden tests
prove that frames tolerate those fields, not that tui-go consumes them.

## Goals

- Make `ToolPresentation` the semantic presentation module for both frontends.
- Preserve OMP-RPC v1 additive compatibility.
- Preserve call arguments through the final presentation snapshot.
- Render current `status`, `block`, and `code` variants natively in tui-go.
- Keep current rendering when presentation is absent, malformed, or unknown.
- Put terminal sanitization and layout in rendering Adapters.
- Prove the full TypeScript-to-Go contract.

## Non-goals

- No new presentation variant.
- No broad tool migration.
- No edit-result rewrite. Edit results stay on the legacy path until their
  presenter emits a neutral result snapshot.
- No removal of pi-tui or specialized Go renderers.
- No OMP-RPC v2 work.

## Chosen design

Use the existing compact vocabulary. Add two deep implementation modules behind
existing seams:

1. A stateful TypeScript presentation projector behind the OMP-RPC translator.
2. A presentation-first Go `ToolRenderer` Adapter that delegates to the current
   renderer when it cannot consume a snapshot.

Do not attach presenters to tool definitions. The separate presenter registry
is intentional: the wire translator stays free of tool construction and pi-tui
transitive imports.

### Canonical data

Split semantic types from the pi-tui Adapter. The canonical file contains only
plain data and has no theme, TUI, width, or component imports. Existing wire
fields remain unchanged for compatibility. Frontends treat layout-oriented
fields as hints, not authority over local interaction state.

`ToolPresentation` remains a closed known set for this implementation:

- `status`: title and optional description, metadata, and semantic icon.
- `block`: optional status plus ordered text sections.
- `code`: code, language, title, status, and optional output.

Unknown JSON fields remain ignored. An unknown variant selects legacy rendering.

### TypeScript lifecycle projector

The projector has one interface: accept a tool execution event and return an
optional complete presentation snapshot. It hides:

- call arguments keyed by tool-call id;
- presenter lookup;
- start/update/end phase options;
- exception isolation and bounded diagnostics;
- cleanup after every terminal event.

Lifecycle rules:

1. Start stores arguments and projects the call snapshot.
2. Update replaces the prior display snapshot. It refreshes stored arguments
   from the event.
3. End projects the result with retained arguments, then clears state in all
   success and failure paths.
4. Every emitted presentation is a full snapshot. No field-wise merge exists.
5. Missing start is safe. End projects without arguments and still clears.
6. Presenter failure removes presentation only. The tool event still crosses
   the wire.

The OMP-RPC translator owns one projector instance per RPC session. This avoids
global state and cross-session leakage.

### Go data flow

Mirror the current wire vocabulary as plain Go data below the UI package. Add an
optional presentation to `message.ToolCall` and `message.ToolResult`.

```text
tool_execution_start.presentation
  -> ToolCall.Presentation

tool_execution_update.partialResult.presentation
  -> ToolResult.Presentation

tool_execution_end.result.presentation
  -> ToolResult.Presentation
```

All `ToolCall` replacement paths must preserve presentation. This includes
streaming argument append and finish transitions.

Each frame is authoritative for its phase:

- Before a result exists, use call presentation when supported.
- Once a result exists, use its presentation when supported.
- A result without supported presentation uses the legacy result renderer. It
  does not retain a stale call snapshot.
- A later supported result snapshot replaces the earlier one wholesale.

### tui-go rendering Adapter

Reuse the existing `ToolRenderer` seam. Wrap every specialized renderer with a
presentation-first Adapter inside `newBaseToolMessageItem`. The Adapter chooses
at render time, so a result-only presentation can arrive after item creation.

```text
RenderTool(opts)
  supported current presentation -> native ToolPresentation renderer
  otherwise                      -> existing specialized renderer
```

This is one interface and one fallback rule for all tools. No second renderer
registry is added.

The native renderer maps semantic data onto existing tui-go styles:

- Tool lifecycle state controls spinner and terminal success/error state.
- Presentation hints cannot keep a completed tool spinning.
- `status` renders a compact header and description.
- `block` renders a header and ordered labeled sections.
- `code` uses existing code rendering and expansion behavior.

The Adapter owns all terminal concerns:

- tabs and unsafe control characters;
- ANSI handling;
- width truncation and wrapping;
- collapsed preview limits;
- cache invalidation after tool-call, result, width, theme, or expansion change.

Producers keep semantic normalization already required by the compact
vocabulary, including safe path display. Moving that work requires typed path
fields and is outside this design.

## Compatibility and errors

- Missing presentation: use legacy rendering.
- Unknown variant: use legacy rendering. This preserves additive v1 evolution.
- Malformed known variant: log a bounded diagnostic and use legacy rendering.
- Tool content, lifecycle, and transcript updates never fail because
  presentation failed.
- Raw details remain available during migration. Canonical renderers do not
  reconstruct presentation meaning from them.

## Specification updates

Update the OMP-RPC v1 README to document optional presentation at:

- `tool_execution_start.presentation`;
- `tool_execution_update.partialResult.presentation`;
- `tool_execution_end.result.presentation`.

State that each value is a complete snapshot and that hosts must ignore unknown
fields or variants without dropping the parent event.

## Verification

### TypeScript contracts

- Pure presentation types have no pi-tui or theme imports.
- Start retains arguments.
- Update replaces snapshots and refreshes arguments.
- End receives retained arguments and always clears state.
- Missing start remains safe. Terminal events always clear retained arguments.
- Presenter exceptions omit presentation but preserve the event.
- Existing wire shapes remain byte-compatible when presentation is absent.

### Shared wire contracts

- Fixtures cover all three variants.
- Fixtures cover start, partial update, and final end.
- A read final fixture proves path and language survive through retained args.
- Unknown fields and variants preserve the parent event.
- Malformed presentation preserves raw result content.

### Go contracts

- Golden fixtures become semantic assertions on stored presentation.
- Tool-call finish and argument append preserve presentation.
- Result presentation replaces call presentation.
- Absent, malformed, and unknown result presentation use legacy rendering.
- Presentation arriving after item construction is rendered.
- Renderer tests cover narrow and wide widths, tabs, control sequences, long
  lines, collapsed and expanded code, lifecycle completion, and errors.
- Existing read and edit legacy tests remain green.

### Runtime proof

Use tmux with the real tui-go frontend:

1. Stream a bash call; verify call summary, legacy result fallback, and terminal
   completion.
2. Read a TypeScript file; verify code, title, language, resize, and expansion.
3. Apply an edit; verify neutral call presentation and legacy diff result.
4. Trigger an error; verify the transcript remains usable.

## Completion criteria

- Go consumes every current ToolPresentation variant.
- The wire README matches the type-level contract.
- Final read presentation retains call arguments.
- Legacy metadata reconstruction runs only when current presentation is absent
  or unusable.
- No presentation failure drops or stalls a tool event.
- Focused TypeScript and Go contract tests pass.
- tui-go runtime proof passes for bash, read, edit, resize, expansion, and error.
- `CONTEXT.md` defines ToolPresentation without tying it to either frontend.
