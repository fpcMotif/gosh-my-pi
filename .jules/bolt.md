## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-20 - SQLite Composite Indices for Filtering and Sorting
**Learning:** In `bun:sqlite`, database operations are synchronous. Queries that combine filtering (e.g., `WHERE stop_reason = 'error'`) and sorting (e.g., `ORDER BY timestamp DESC`) will result in full table scans and blocking in-memory sorts if only individual indices exist, degrading application responsiveness.
**Action:** Always add composite indices (e.g., `(stop_reason, timestamp)`) for frequent filter and sort combinations to prevent Node.js main thread blocking during synchronous database operations.
