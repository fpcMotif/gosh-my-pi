## 2024-06-25 - [Promise Coalescing for Backend Reads]
**Learning:** Concurrent frontend requests to the stats API can cause redundant database queries and file I/O operations (like syncing all sessions or computing dashboard stats).
**Action:** Implement and use a promise coalescing (deduplication) pattern for heavy, read-only or synchronizing operations. This ensures multiple overlapping requests share a single execution promise until it resolves.
