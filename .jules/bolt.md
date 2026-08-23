## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-08-23 - SQLite Partial Index Performance
**Learning:** In SQLite, for queries that filter on a specific condition and order by a column (e.g., `WHERE stop_reason = 'error' ORDER BY timestamp DESC`), using a partial index covering the ordered column and filtered by the condition (e.g., `ON messages(timestamp DESC) WHERE stop_reason = 'error'`) significantly speeds up execution compared to standard indices by eliminating full index scans.
**Action:** Add partial covering indices when heavily querying and sorting a specific subset of data.
