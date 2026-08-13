## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-05-18 - SQLite Partial Indexes for Filtered Queries
**Learning:** Using a regular index on `timestamp` for `SELECT * FROM messages WHERE stop_reason = 'error' ORDER BY timestamp DESC LIMIT 100` forces the database to scan the timestamp index and check the condition on every row. By creating a partial index `ON messages(timestamp DESC) WHERE stop_reason = 'error'`, the query engine can jump straight to the errors and significantly speed up execution (e.g. 5.7ms to 0.5ms).
**Action:** Use partial indexes to optimize queries that filter on a specific condition and order by another column.
