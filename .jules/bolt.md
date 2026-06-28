## 2024-06-28 - [Coalescing Database Sync]
**Learning:** `syncAllSessions` was being redundantly executed when multiple stats requests arrive concurrently (e.g. from the dashboard loading multiple panels simultaneously). Since this parses files and syncs to SQLite, concurrent calls created unnecessary file I/O and DB operations.
**Action:** Implemented a promise coalescing pattern to deduplicate ongoing `syncAllSessions` requests. New requests wait for any current sync to finish and batch into a single next sync instead of executing concurrently.
