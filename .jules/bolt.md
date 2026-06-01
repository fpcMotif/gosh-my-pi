## 2025-05-18 - Promise Coalescing for Server
**Learning:** `syncAllSessions` can be invoked many times concurrently if many frontend API endpoints are hit simultaneously, causing redundant I/O and database operations.
**Action:** Implement a promise coalescer around `syncAllSessions` in `server.ts` or `aggregator.ts`.
