## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-09-05 - SQLite Partial Index for Filtered Orders
**Learning:** When querying SQLite with a WHERE clause on one column (e.g., stop_reason='error') and ordering by another (timestamp), standard indices on the ordered column still require a full index scan to filter out non-matching rows. A partial index (WHERE stop_reason='error') eliminates this scan entirely.
**Action:** Use partial indices on ordered columns for frequently queried subsets of data to achieve >10x speedups.
