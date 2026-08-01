## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-18 - Missing SQLite Composite Indices Block Event Loop
**Learning:** Missing indices on commonly queried filtered + sorted fields (like stop_reason + timestamp) cause synchronous full index scans when matches are rare, blocking the Node.js event loop in bun:sqlite.
**Action:** Always add composite indices that cover both selected and grouped/sorted fields to prevent main thread blocking.
