# Autoresearch: coding-agent latency and responsiveness

## Objective
Improve the `packages/coding-agent` runtime latency that users feel while the agent searches for tools/files, executes shell commands, and updates the terminal UI. Favor changes that make search and execution paths faster without reducing correctness or making the UI less informative.

## Metrics
- **Primary**: `total_ms` (ms, lower is better) — median end-to-end synthetic agent-latency workload from `./autoresearch.sh`.
- **Secondary**: `bm25_query_ms`, `bm25_index_ms`, `file_search_ms`, `bash_render_ms`, `tool_discovery_render_ms` — phase timings for localization.

## How to Run
`./autoresearch.sh`

The script runs `autoresearch/agent-latency-bench.ts` and outputs structured `METRIC name=value` lines. It warms once, runs multiple rounds, then reports medians.

## Workload
The benchmark exercises:
- MCP/tool discovery BM25 search over thousands of synthetic tools.
- `SearchTool.execute()` against `packages/coding-agent/src` using real native grep and result formatting.
- Bash and tool-discovery TUI renderers with large output/result sets, measuring collapsed rendering responsiveness.

## Files in Scope
- `packages/coding-agent/src/mcp/discoverable-tool-metadata.ts` — MCP tool metadata indexing and BM25 ranking.
- `packages/coding-agent/src/tools/search-tool-bm25.ts` — tool discovery execution and rendering.
- `packages/coding-agent/src/tools/search.ts` — file/code search orchestration and renderer.
- `packages/coding-agent/src/tools/bash.ts` — bash execution setup and TUI renderer.
- `packages/coding-agent/src/exec/bash-executor.ts` — shell execution overhead and streaming output path.
- `packages/coding-agent/src/tools/render-utils.ts` — shared renderer formatting/truncation helpers.
- `packages/coding-agent/src/modes/components/tool-execution.ts` — tool-call/result update and render coordination.
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
- Baseline pending.
