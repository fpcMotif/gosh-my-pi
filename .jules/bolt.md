## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-20 - SQLite Composite Indexes for Grouping/Ordering
**Learning:** In SQLite, queries that group by or sort by multiple columns without a covering index will use temporary B-Trees (indicated by "USE TEMP B-TREE" in EXPLAIN QUERY PLAN), which causes massive performance penalties on large datasets. Creating specific composite indexes that exactly match the GROUP BY or ORDER BY columns eliminates the temporary B-Tree and uses a covering index scan, significantly speeding up queries.
**Action:** Always create composite indexes for frequently executed queries that filter, group, or order by multiple columns, and verify with EXPLAIN QUERY PLAN to ensure no temporary B-Trees are used.
