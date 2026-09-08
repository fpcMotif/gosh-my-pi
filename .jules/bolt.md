## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-09-08 - SQLite Partial Indexes for Filtered Queries
**Learning:** In SQLite, queries that filter on a specific condition and order by a timestamp (e.g., `WHERE stop_reason = 'error' ORDER BY timestamp DESC`) can suffer from full index scans on the timestamp index. Creating a partial index that covers the ordered column and filters by the condition (e.g., `CREATE INDEX idx ON table(timestamp DESC) WHERE stop_reason = 'error'`) eliminates full index scans and speeds up execution significantly (e.g., 10x faster).
**Action:** Use partial indexes for queries that filter on a specific status and sort by time.
