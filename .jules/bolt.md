## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-09-07 - SQLite Partial Indexes for Filtered Time Series
**Learning:** In SQLite, for queries that filter on a specific condition and order by a column (like `WHERE stop_reason = 'error' ORDER BY timestamp DESC`), a standard index results in a full index scan. Using a partial index covering the ordered column and filtered by the condition (`ON table(timestamp DESC) WHERE condition`) changes this to a fast covering index lookup.
**Action:** Apply partial covering indexes for dashboard queries that filter for specific error states or statuses while ordering by time.
