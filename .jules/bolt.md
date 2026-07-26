## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-05-18 - Fast DB Aggregates with Composite Indices
**Learning:** In `bun:sqlite`, database operations are synchronous. Missing composite indices for commonly grouped fields (like `model` and `provider`) cause temporary B-TREE usage that can block the Node.js event loop and degrade performance.
**Action:** Always add composite indices that cover both selected and grouped fields to prevent main thread blocking and ensure covering index scans.
