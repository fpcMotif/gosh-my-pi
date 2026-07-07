## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-07 - Promise Coalescing for Concurrent Reads
**Learning:** For heavy read-only backend operations (e.g., fetching multiple aggregated stats from SQLite) that are often triggered simultaneously by the frontend (like when the dashboard loads multiple API endpoints at once), redundant I/O and DB queries can cause a significant bottleneck.
**Action:** Implement a promise coalescing (request deduplication) pattern. Cache the initial execution promise and return it to any subsequent concurrent callers. Reset the cached promise in a `.finally()` block when the operation completes.
