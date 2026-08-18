## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2025-02-18 - SQLite Partial Covering Indices for Ordered Filters
**Learning:** In SQLite, when querying with a specific filter condition and sorting (e.g. `WHERE stop_reason = 'error' ORDER BY timestamp DESC`), using a partial index like `CREATE INDEX idx_messages_errors ON messages(timestamp DESC) WHERE stop_reason = 'error'` acts as a covering index, eliminating the need for full table scans and making queries orders of magnitude faster.
**Action:** Use partial indices for queries with static filters that also require ordering, to optimize performance with minimal space overhead.
