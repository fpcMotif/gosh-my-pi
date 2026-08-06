## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-20 - SQLite Composite Indexing and Event Loop
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing indices on commonly queried fields (like combining filtering, sorting, or grouping, e.g. querying errors ordered by timestamp) cause full table scans or temporary B-TREE usage. This blocks the Node.js/Bun event loop and degrades application responsiveness.
**Action:** Always add composite indices that cover both selected and grouped/sorted fields (e.g. `(stop_reason, timestamp)` or `(model, provider)`) to prevent main thread blocking.
