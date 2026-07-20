## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-03-24 - Database Index Optimization
**Learning:** SQLite query planner uses temp B-trees for `GROUP BY` when grouping by `model, provider` but we only have an index on `model`. Additionally, filtering by `stop_reason` and ordering by `timestamp` causes full table scans with an index on `timestamp` alone when many errors exist.
**Action:** Adding compound indexes on `(model, provider)` and `(stop_reason, timestamp)` prevents temp B-tree usage and optimizes recent error queries.
