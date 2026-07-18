## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-18 - SQLite Composite Indices for Grouping
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing composite indices on commonly queried and grouped fields (like grouping by both `model` and `provider`) cause the engine to use temporary B-TREEs for grouping, leading to significantly slower performance and blocking the Node.js event loop.
**Action:** Always add composite indices that cover both the selected and grouped fields to allow SQLite to stream results directly from the index, roughly halving query execution times and preventing main thread blocking.
