## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-08-09 - SQLite Composite Index Optimization
**Learning:** In SQLite, composite indices cannot fully eliminate temporary B-TREE usage for `GROUP BY` or `ORDER BY` if the query groups by an expression derived from the indexed column (like timestamp bucketing). Thus, focus composite indexing efforts on exact matching grouped/sorted columns.
**Action:** Add composite index on `(model, provider)` and `(stop_reason, timestamp DESC)` to optimize frequent matching grouped/sorted queries like `getStatsByModel` and `getRecentErrors`.
