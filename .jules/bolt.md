## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-08-30 - SQLite Partial Indexing for Filtered Sorts
**Learning:** Using a partial index covering the ordered column and filtered by the condition (e.g., `ON table(timestamp DESC) WHERE status = 'error'`) significantly speeds up execution compared to standard indices by eliminating full index scans.
**Action:** Use partial indices for queries that filter on a specific condition and order by a column.
