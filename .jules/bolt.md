## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-19 - Synchronous SQLite Blocking
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing composite indexes on commonly grouped/sorted fields (like `model` and `provider` in aggregated stats queries) cause temporary B-TREE usage (`USE TEMP B-TREE FOR GROUP BY`), which blocks the Node.js event loop and degrades application responsiveness for large datasets. Note that expressions derived from indexed columns (like `timestamp / 86400000 as bucket`) cannot fully utilize the index to skip the temporary B-Tree for grouping, so composite indexes should focus on exact column matches.
**Action:** Always verify query plans using `EXPLAIN QUERY PLAN` and add composite indices covering exact matching grouped/sorted columns to prevent main thread blocking in synchronous environments.
