## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## $(date +%Y-%m-%d) - SQLite Composite Index Optimization
**Learning:** Missing composite indexes on fields used for grouping (`model, provider`) or combined filtering and sorting (`stop_reason, timestamp DESC`) cause full table scans and temporary B-TREE usage. In `bun:sqlite`, these operations are synchronous and block the Node.js event loop, degrading performance.
**Action:** Always add composite indexes covering exactly the grouped, sorted, or filtered columns to prevent main thread blocking during aggregation queries.

## 2025-01-28 - SQLite Composite Index Optimization
**Learning:** Missing composite indexes on fields used for grouping (`model, provider`) or combined filtering and sorting (`stop_reason, timestamp DESC`) cause full table scans and temporary B-TREE usage. In `bun:sqlite`, these operations are synchronous and block the Node.js event loop, degrading performance.
**Action:** Always add composite indexes covering exactly the grouped, sorted, or filtered columns to prevent main thread blocking during aggregation queries.
