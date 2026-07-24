## 2024-07-24 - Database Indexes for Stats Dashboard
**Learning:** In `packages/stats/src/db.ts`, methods like `getStatsByModel()`, `getModelTimeSeries()`, and `getCostTimeSeries()` execute GROUP BY and aggregations. Missing composite indices causes slow full table scans or temporary B-TREE creation on the main thread, blocking event loop responsiveness.
**Action:** Always add covering composite indices (e.g. `(model, provider)`) in `bun:sqlite` when combining `GROUP BY` and aggregations to improve read speed and keep the UI responsive.

## 2024-07-24 - Database Indexes for Stats Dashboard
**Learning:** In `packages/stats/src/db.ts`, methods like `getStatsByModel()`, `getModelTimeSeries()`, and `getCostTimeSeries()` execute GROUP BY and aggregations. Missing composite indices causes slow full table scans or temporary B-TREE creation on the main thread, blocking event loop responsiveness.
**Action:** Always add covering composite indices (e.g. `(model, provider)`) in `bun:sqlite` when combining `GROUP BY` and aggregations to improve read speed and keep the UI responsive.
