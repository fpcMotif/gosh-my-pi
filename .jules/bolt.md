## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-05-18 - SQLite Composite Indexing for GROUP BY
**Learning:** In Bun's SQLite, when performing grouped/sorted queries like `GROUP BY model, provider` or `GROUP BY timestamp, model, provider`, using simple single-column indices leads to temporary B-TREE usage which degrades performance and blocks the main thread.
**Action:** Use composite indices that cover both the selected and grouped/sorted fields to prevent main thread blocking.
