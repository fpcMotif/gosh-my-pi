## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-22 - SQLite Query Optimization with Composite Indices
**Learning:** In `bun:sqlite`, queries with `GROUP BY` and `ORDER BY` on multiple columns (like `model`, `provider`, and `bucket` based on `timestamp`) can block the main thread by falling back to temporary B-TREEs if appropriate composite indices are missing. Adding indices that cover the selected and grouped fields (`model, provider` and `timestamp, model, provider`) avoids full table scans and allows SQLite to use the covering index efficiently.
**Action:** Always add composite indices that cover both selected and grouped/sorted fields for frequently queried combinations in SQLite to prevent main thread blocking in Node.js/Bun event loop.
