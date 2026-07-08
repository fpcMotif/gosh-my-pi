## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-08 - SQLite Missing Indices and Event Loop Blocking
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing indices on commonly queried conditions (like filtering by `stop_reason = 'error'` and sorting by `timestamp`) can cause slow full table scans, especially as data grows. Since these queries run synchronously, they block the event loop, causing poor application responsiveness.
**Action:** Always add composite indices for frequent filter and sort combinations in `bun:sqlite` to prevent main thread blocking, such as adding `CREATE INDEX idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);` for `getRecentErrors`.
