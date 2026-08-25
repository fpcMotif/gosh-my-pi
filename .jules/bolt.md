## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-18 - Fast Error Log Queries with Partial Indexes
**Learning:** In SQLite, queries that filter on a specific condition and order by a column (like WHERE status = 'error' ORDER BY timestamp DESC) cause full index scans if errors are rare. Standard indexes don't optimize this well.
**Action:** Use a partial index covering the ordered column and filtered by the condition (e.g., ON table(timestamp DESC) WHERE status = 'error') to turn these O(N) index scans into O(1) lookups.
