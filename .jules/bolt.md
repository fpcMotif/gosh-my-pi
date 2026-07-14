## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-14 - SQLite Composite Indexes for Query Blocking
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing indices on commonly queried fields (like combining filtering and sorting, e.g., `stop_reason = 'error' ORDER BY timestamp DESC`) cause full table scans that block the Node.js event loop and significantly degrade application responsiveness, even for seemingly simple queries when tables grow large.
**Action:** Always add composite indices for frequent filter and sort combinations to prevent main thread blocking, ensuring predictable performance.
