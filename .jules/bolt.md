## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-08-04 - SQLite Event Loop Blocking
**Learning:** In bun:sqlite, database operations are synchronous. Missing composite indices on fields used in filtering, sorting, or grouping (e.g., `stop_reason` + `timestamp`, or `model` + `provider`) cause SQLite to use temporary B-trees or full index scans, which block the Node.js event loop and degrade application responsiveness.
**Action:** Always add composite indices that cover both selected and grouped/sorted fields for synchronous SQLite queries to prevent main thread blocking.
