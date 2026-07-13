## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-20 - SQLite Composite Indices for Filtering and Sorting
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing indices on commonly queried fields (like combining filtering and sorting, e.g., \`stop_reason\` and \`timestamp\`, or grouping by multiple fields like \`model\` and \`provider\`) cause full table scans that block the Node.js event loop and degrade application responsiveness.
**Action:** Always add composite indices for frequent filter, sort, and group by combinations to prevent main thread blocking in SQLite databases.
