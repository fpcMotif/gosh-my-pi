## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-18 - Composite SQLite Indices for GROUP BY
**Learning:** In `bun:sqlite`, queries that group or sort by multiple fields (like `model` and `provider`) without a covering composite index result in temporary B-TREE creation, which blocks the Node.js event loop due to synchronous database operations.
**Action:** Always create composite indices that cover all fields used in `GROUP BY` or `ORDER BY` clauses to ensure fast index scans and prevent main thread blocking.
