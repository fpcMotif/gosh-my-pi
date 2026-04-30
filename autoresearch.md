# Autoresearch: coding-agent latency and responsiveness

## Objective
Improve the `packages/coding-agent` runtime latency that users feel while the agent searches for tools/files, executes shell commands, and updates the terminal UI. Favor changes that make search and execution paths faster without reducing correctness or making the UI less informative.

## Metrics
- **Primary**: `total_ms` (ms, lower is better) — median end-to-end synthetic agent-latency workload from `./autoresearch.sh`.
- **Secondary**: `bm25_query_ms`, `bm25_index_ms`, `result_format_ms`, `summary_ms` — phase timings for localization.

## How to Run
`./autoresearch.sh`

The script runs `autoresearch/agent-latency-bench.ts` and outputs structured `METRIC name=value` lines. It warms once, runs multiple rounds, then reports medians.

## Workload
The benchmark exercises native-independent MCP/tool discovery latency:
- BM25 search over thousands of synthetic discoverable tools.
- Search-result formatting that mirrors `search_tool_bm25` detail shaping.
- Tool-server summary generation used in tool-discovery descriptions.

Native grep and TUI renderer phases were intentionally left out of this first segment because the local Windows native binding is missing; add them back once `@oh-my-pi/pi-natives` is buildable in this environment.

## Files in Scope
- `packages/coding-agent/src/mcp/discoverable-tool-metadata.ts` — MCP tool metadata indexing and BM25 ranking.
- `packages/coding-agent/src/tools/search-tool-bm25.ts` — tool discovery execution and rendering.
- `packages/coding-agent/src/tools/search.ts` — file/code search orchestration and renderer, only if native bindings are available for validation.
- `packages/coding-agent/src/tools/bash.ts` — bash execution setup and TUI renderer, only if native bindings are available for validation.
- `packages/coding-agent/src/exec/bash-executor.ts` — shell execution overhead and streaming output path, only if native bindings are available for validation.
- `packages/coding-agent/src/tools/render-utils.ts` — shared renderer formatting/truncation helpers, only if native bindings are available for validation.
- `packages/coding-agent/src/modes/components/tool-execution.ts` — tool-call/result update and render coordination, only if native bindings are available for validation.
- `packages/coding-agent/test/**` — only focused tests that defend externally observable behavior touched by an optimization.
- `autoresearch.md`, `autoresearch.sh`, `autoresearch/agent-latency-bench.ts` — benchmark/session documentation.

## Off Limits
- Do not touch generated files such as `packages/ai/src/models.json`.
- Do not edit prompt text unless the optimization specifically requires prompt behavior changes.
- Do not alter or commit pre-existing user work that was stashed before this session (`assistant-message.ts`, `user-message.ts`, `interactive-mode.ts`).
- Do not remove UI information, search results, truncation warnings, safety checks, or shell/session behavior just to improve the benchmark.

## Constraints
- No new dependencies unless absolutely necessary.
- Preserve public tool contracts and renderer output semantics.
- Follow repo style: no `any` unless unavoidable, no `ReturnType<>`, no inline imports, no console logging in `packages/coding-agent`.
- Prefer simple, measurable changes. Keep primary improvements only when the benchmark improves; discard unchanged/worse runs.

## What's Been Tried
- Initial `./autoresearch.sh` run failed because the autoresearch tool could not find `bash`; a local bash shim was added outside the repo in the user agent bin path.
- A benchmark including `SearchTool`/renderer imports failed because `@oh-my-pi/pi-natives` is missing locally and native build currently fails at `cargo metadata`; the current segment avoids native-dependent imports and focuses on pure MCP/tool-discovery search latency.
- Baseline pending for the native-independent segment.
