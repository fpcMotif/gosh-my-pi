## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-18 - SQLite Composite Index Optimization
**Learning:** A single column index on `model` still requires SQLite to use a temporary B-Tree (`USE TEMP B-TREE FOR GROUP BY`) when grouping by `model, provider` in queries. Using a composite index on `(model, provider)` allows SQLite to avoid building this temporary B-Tree, significantly improving query performance.
**Action:** When creating indexes for heavily grouped queries, ensure the index covers the exact combination and order of columns used in the `GROUP BY` clause.
