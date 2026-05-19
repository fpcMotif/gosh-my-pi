
## 2026-05-19 - [Dashboard Concurrent Data Fetching Optimization]
**Learning:** Concurrent fetch requests (e.g. rapid tab switching or polling) against heavy backend data aggregation endpoints (`getDashboardStats`) can trigger redundant overlapping queries to the SQLite stats database.
**Action:** Always wrap heavy read-only aggregating functions with `coalesce` from `@oh-my-pi/pi-utils` to deduplicate and share promise evaluations across concurrent callers, reducing DB load.
