## 2025-05-18 - Promise Coalescing for Backend Heavy Read/Sync Operations
**Learning:** In the stats backend (`packages/stats`), concurrent frontend requests to API endpoints (`/api/stats`, `/api/sync`) can trigger redundant executions of heavy operations like scanning all session files and running database aggregations.
**Action:** Implement promise coalescing (request deduplication). By assigning the executing Promise to a module-level variable and returning it immediately to any subsequent concurrent callers, redundant file I/O and DB queries are prevented, saving CPU and disk operations.
