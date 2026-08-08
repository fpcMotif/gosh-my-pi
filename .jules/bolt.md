## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-18 - SQLite Composite Indexes for GROUP BY
**Learning:** SQLite uses a temporary B-Tree for `GROUP BY` operations unless a composite index perfectly covers all grouped columns. Replacing `idx_messages_model` with a composite index on `(model, provider)` eliminates the TEMP B-TREE in `getStatsByModel`, significantly speeding up the query.
**Action:** Always create composite indexes that match the exact sequence of `GROUP BY` columns to avoid temporary B-Tree construction.
