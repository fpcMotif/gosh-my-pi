## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-06-25 - Bun SQLite Index Optimization
**Learning:** In `bun:sqlite`, database operations are synchronous and can block the Node.js event loop if slow. Missing indices on commonly queried combinations (like combining filtering with sorting, or grouping over multiple columns) cause temporary B-TREE usage or full table scans that degrade application responsiveness. For example, `WHERE stop_reason = 'error' ORDER BY timestamp DESC` needs `CREATE INDEX idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);` and `GROUP BY model, provider` needs `CREATE INDEX idx_messages_model_provider ON messages(model, provider);`.
**Action:** Always add composite indices that cover both selected and grouped/sorted fields to prevent main thread blocking in bun:sqlite.
