## 2025-03-01 - Slice Bytes Instead of Subarray for Bun Files
**Learning:** `Bun.file(path).slice(start).bytes()` is significantly faster than `await Bun.file(path).bytes()` followed by `.subarray(start)` when reading trailing appended data, but it needs manual bounds calculation (`const size = Bun.file(path).size`) and still needs a try-catch for ENOENT to avoid Time-Of-Check to Time-Of-Use race conditions.
**Action:** When extracting data from the end of large files (e.g. log files or session jsonl files), use `.slice(start).bytes()` and calculate the offset correctly.
