
## 2024-07-02 - Use file slice() instead of subarray() for partial reads
**Learning:** In Bun, calling `Bun.file(path).bytes()` followed by `.subarray(start)` reads the entire file into memory before subsetting. For large session files where only the appended tail needs parsing, this creates unnecessary memory pressure and I/O bottlenecks.
**Action:** When extracting specific sections or trailing bytes from large files, prefer `Bun.file(path).slice(start).bytes()`. Pre-compute size and bounds manually (`const size = Bun.file(path).size`) to handle out-of-bounds correctly, and always wrap the `.bytes()` read in a `try/catch` to handle `ENOENT` safely.
