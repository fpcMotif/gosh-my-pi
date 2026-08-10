## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-05-18 - Composite Indices for GROUP BY in SQLite
**Learning:** In SQLite, composite indices eliminate temporary B-TREE usage for `GROUP BY` when exact matching grouped columns (like `model, provider`), but not if the `GROUP BY` involves derived expressions (like `(timestamp / 86400000) as bucket`).
**Action:** Focus composite indexing efforts on exact matching grouped/sorted columns. Use `EXPLAIN QUERY PLAN` to verify temporary B-TREE usage.
