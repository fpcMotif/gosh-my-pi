## 2024-06-03 - Promise Coalescing for Heavy Backend Operations
**Learning:** When frontends dispatch concurrent API requests on load (e.g. `Promise.all` for overview stats, requests, and errors), having the backend blindly trigger a heavy filesystem/database sync per request causes redundant I/O and lock contention.
**Action:** Apply request deduplication (Promise Coalescing) to backend synchronizations so that concurrent calls seamlessly reuse a single execution promise rather than launching identical overlapping work.
