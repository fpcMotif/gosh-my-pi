## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2025-05-20 - SQLite Partial Index for Ordered Filters
**Learning:** In SQLite, queries that filter on a condition and order by a timestamp (e.g., `WHERE stop_reason = 'error' ORDER BY timestamp DESC`) can suffer from full index scans on the timestamp index. A partial index (`ON messages(timestamp DESC) WHERE stop_reason = 'error'`) makes this O(1) and ~100x faster.
**Action:** Always use partial indexes for queries combining a strict filter with ordering to avoid full index scans.
