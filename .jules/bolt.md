## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-09-09 - SQLite Partial Index for Ordered Filtering
**Learning:** In SQLite, queries that filter on a specific condition and order by a column (e.g., `WHERE status = 'error' ORDER BY timestamp DESC`) can perform full index scans even if the ordered column is indexed. Using a partial index covering the ordered column and filtered by the condition (e.g., `ON table(timestamp DESC) WHERE status = 'error'`) eliminates full index scans, significantly speeding up execution.
**Action:** Use partial indices for queries that combine filtering on a specific value and ordering by another column.
