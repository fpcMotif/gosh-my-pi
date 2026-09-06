## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-09-06 - SQLite Partial Indexing for Ordered Queries
**Learning:** For queries that filter on a specific condition and order by a column (e.g., `WHERE stop_reason = 'error' ORDER BY timestamp DESC`), adding a partial index that covers the ordered column and filters by the condition (e.g., `ON messages(timestamp DESC) WHERE stop_reason = 'error'`) makes the query O(log N) and avoids full index scans on the timestamp index.
**Action:** Use partial covering indexes when frequently querying a specific subset of data sorted by time or other criteria.
