## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2026-08-24 - SQLite Partial Index Pattern
**Learning:** For queries filtering on a condition and ordering by another column (e.g., WHERE status = 'error' ORDER BY timestamp DESC), standard indexes lead to full index scans. A partial index covering the ordered column and filtered by the condition significantly speeds up execution.
**Action:** Use partial indices (ON table(column) WHERE condition) to optimize frequent sorted+filtered queries.
