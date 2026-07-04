## 2024-07-04 - Promise Coalescing for Backend Synchronization
**Learning:** Concurrent requests triggering redundant disk reads/writes can severely bottleneck the backend (e.g., when multiple client views concurrently fetch from `/api/stats` and trigger `syncAllSessions`).
**Action:** Implemented a chained `currentSyncPromise` / `nextSyncPromise` logic. It avoids repeated file `stat` and db operations when concurrent syncs are requested, queuing at most one subsequent sync so updates arriving during the current sync aren't missed.
