## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-12 - Composite Index for Filtering and Sorting
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing composite indexes on commonly queried fields (such as combining filtering with `stop_reason = 'error'` and sorting by `timestamp DESC`) causes full table scans or suboptimal single-index lookups. This blocks the Node.js event loop and degrades application responsiveness.
**Action:** Always add composite indexes (e.g., `(stop_reason, timestamp DESC)`) for frequent filter and sort combinations to prevent main thread blocking during synchronous database operations.
