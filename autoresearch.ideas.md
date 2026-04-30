# Autoresearch Ideas

- Summary-only optimization is stale for the current primary metric: null-prototype/manual summary counting repeatedly cut `summary_ms` but did not beat total best. Revisit only in a summary/UI-description focused segment or combined with a clear query-path win.
- Add native/TUI phases back to the benchmark after `@oh-my-pi/pi-natives` builds on this Windows machine; current segment focuses on native-independent MCP tool discovery.
- Add focused semantic tests for BM25 ranking parity (score order, name tie-break, exclusions, fallback indexes without postings) before final review.
