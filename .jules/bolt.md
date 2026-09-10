## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-09-10 - SQLite Partial Indices for Filtered Sorts
**Learning:** In SQLite, queries that filter on a condition and order by a column (like `WHERE stop_reason = 'error' ORDER BY timestamp DESC`) can be heavily optimized using a partial index (e.g., `ON table(timestamp DESC) WHERE stop_reason = 'error'`). This prevents full index scans of the main index and only scans the subset of matching rows, drastically speeding up queries on large datasets.
**Action:** Use partial indices when queries filter by a specific condition and sort results, rather than relying solely on a full index.
