## 2025-06-04 - [Promise Coalescing for DB Sync]
**Learning:** High-concurrency environments querying dashboard endpoints triggered simultaneous SQLite DB writes/reads due to missing request deduplication for `syncAllSessions`.
**Action:** Implemented module-level promise coalescing (memoizing the active promise) in `syncAllSessions` to prevent redundant file I/O and DB operations during concurrent frontend requests.
