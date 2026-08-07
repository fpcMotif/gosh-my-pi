## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2025-01-20 - Composite Indices Eliminate Temp B-Trees
**Learning:** In SQLite, adding composite indices on exactly matching grouped/sorted columns (like `model, provider` or `stop_reason, timestamp DESC`) allows the query planner to use a covering index scan and avoid expensive `USE TEMP B-TREE FOR GROUP BY/ORDER BY` operations, significantly speeding up analytical dashboard queries.
**Action:** Always verify if complex GROUP BY / ORDER BY statements can leverage composite indices to avoid building temporary B-trees in memory.
