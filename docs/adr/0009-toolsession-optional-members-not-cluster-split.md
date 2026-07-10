# ADR 0009: ToolSession keeps optional-member design; no capability-cluster split

## Status

Accepted — 2026-07-11. Records the rejection of a 2026-07 architecture-review
candidate so future reviews do not re-propose it.

## Context

`ToolSession` (`packages/coding-agent/src/tools/index.ts:109-206`) is a
47-member interface — 5 required members (`cwd`, `hasUI`,
`getSessionFile`, `getSessionSpawns`, `settings`) and 42 optional. The
review proposed splitting it into typed capability clusters (Python
lifecycle, artifacts, MCP selection, subagent context, …) to reduce the
mock burden and make tool dependencies explicit.

An adversarial necessity check refuted the split:

1. **Optionality is load-bearing.** There is exactly one object-literal
   construction site (`packages/coding-agent/src/sdk.ts:948`). Subagents
   flow through the same path and pass a strict subset of members —
   the optional-member design *is* the reduced-session mechanism.
   Required cluster objects would force explicit `undefined`-populated
   sub-objects: more code for identical behavior.
2. **Tests already have the mitigation.** 28+ of the 33 test files
   referencing `ToolSession` use ~5-15-line `createSession(overrides)`
   helpers over the 5 required members; one test file already defines an
   ad hoc narrowed type (`MCPDiscoveryToolSession`) at near-zero cost.
3. **Blast radius without forcing evidence.** ~39 tool classes hold
   `session: ToolSession` as a constructor parameter property (the
   documented AGENTS.md convention). A split touches all of them to
   enforce a compile-time property no bug report, flake, or onboarding
   complaint has asked for.

## Decision

- `ToolSession` keeps the flat, optional-member shape. The informal
  cluster structure (members grouped by concern in the declaration) is
  documentation, not type surface.
- The accepted minimal alternative, to be applied opportunistically: the
  five MCP-discovery members (`isMCPDiscoveryEnabled`,
  `getDiscoverableMCPTools`, `getDiscoverableMCPSearchIndex`,
  `getSelectedMCPToolNames`, `activateDiscoveredMCPTools`) may collapse
  into a single `getMCPSelectionStore()` accessor, because
  `MCPSelectionStore` already owns that state and
  `agent-session.ts:1579-1611` already delegates 1:1 to it.

## Consequences

- Future reviews should treat wide-but-optional interfaces with a single
  construction site as a deliberate pattern here, not automatic
  shallowness — the deletion test on the split fails (complexity would
  move into per-cluster plumbing, not concentrate).
- If a second real construction site with materially different member
  sets appears, or extension authors gain the ability to construct
  `ToolSession`, this decision should be revisited.
