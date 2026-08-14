## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-08-14 - SQLite Partial Indices for Filtered Sorts
**Learning:** In SQLite, queries that filter on a specific condition and order by a column (e.g., `WHERE status = 'error' ORDER BY timestamp DESC`) can be significantly optimized using a partial index (e.g., `ON table(timestamp DESC) WHERE status = 'error'`). This eliminates full index scans and makes retrieving specific filtered results much faster.
**Action:** Use partial indices covering the sorted column and filtered condition for high-frequency queries like recent errors.
