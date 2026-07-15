## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-07-15 - Missing Composite Index for SQLite Queries
**Learning:** When querying a SQLite table for a specific column value and ordering by another (like `WHERE stop_reason = 'error' ORDER BY timestamp DESC`), a single index on the order column causes a full table scan. This becomes an O(N) operation which gets slower as the table grows.
**Action:** Add a composite index on both the filter and order columns (e.g., `(stop_reason, timestamp)`) to allow the query planner to perform an O(1) index lookup.
