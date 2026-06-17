## 2024-05-18 - Promise Coalescing in Aggregators
**Learning:** Heavy read-only or synchronizing backend operations in `packages/stats/src/aggregator.ts` (like `syncAllSessions` and `getDashboardStats`) can cause redundant file I/O and database queries when hit concurrently by the frontend.
**Action:** Use a `currentSyncPromise` / `nextSyncPromise` pattern for state-syncing operations to avoid dropping updates, and a `currentStatsPromise` pattern for read-only operations. This request deduplication dramatically improves performance under concurrent load without sacrificing correctness.
