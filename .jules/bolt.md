## 2025-05-27 - [Performance] Safe Coalescing for File Syncs
**Learning:** Naive promise coalescing in `packages/stats/src/aggregator.ts` mitigates file read storms from concurrent React dashboard fetches (`/api/stats`, `/api/stats/recent`, etc.). However, it does not guarantee that files added *during* the sync are processed for callers that arrive mid-sync.
**Action:** When implementing promise coalescing for file I/O or DB syncs, consider if exact read-after-write consistency is required. If so, a chained queue or Mutex pattern is preferable to simple promise caching.
