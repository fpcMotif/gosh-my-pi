## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2025-01-01 - SQLite Partial Index for Filtered Orders
**Learning:** In SQLite, queries that filter on a specific condition and order by a column (like `WHERE stop_reason = 'error' ORDER BY timestamp DESC`) will full-scan a regular timestamp index if the condition is rare.
**Action:** Use a partial index covering the ordered column and filtered by the condition (e.g., `ON table(timestamp DESC) WHERE stop_reason = 'error'`) to eliminate full index scans and massively improve performance.
