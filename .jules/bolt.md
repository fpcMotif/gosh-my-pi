## 2024-06-25 - Promise Coalescing for Redundant File I/O
**Learning:** Concurrent frontend requests to a backend API can trigger redundant file I/O operations (like syncing session files from `.jsonl`) or database queries. This is a codebase-specific performance pattern/bottleneck.
**Action:** Apply promise coalescing (request deduplication) for heavy read-only or synchronizing backend operations to ensure concurrent calls share the same execution promise.
