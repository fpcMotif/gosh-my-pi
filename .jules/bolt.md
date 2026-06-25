
## 2024-06-25 - Bun Partial File Read Optimization
**Learning:** When extracting trailing bytes from large files in Bun (e.g. parsing appended data in `.jsonl` session files), using `Bun.file(path).slice(start).bytes()` avoids massive memory overhead compared to `await Bun.file(path).bytes()` followed by `.subarray(start)`. However, `Bun.file(path).size` evaluates to 0 without throwing if the file does not exist, whereas `file.slice(start).bytes()` correctly throws an `ENOENT` error.
**Action:** When applying the `slice().bytes()` pattern, compute bounds carefully using `file.size` to prevent out-of-bounds reads, but always retain a `try/catch` block for `ENOENT` to handle missing files safely and avoid Time-Of-Check to Time-Of-Use (TOCTOU) race conditions.
