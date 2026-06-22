
## 2024-05-18 - File Reading Optimization with Bun
**Learning:** For large files, loading the entire file via `await Bun.file(path).bytes()` and then using `.subarray(start)` is highly inefficient and creates significant memory overhead. In contrast, using `await Bun.file(path).slice(start).bytes()` streams only the required bytes from the file system. In Bun, attempting to `.bytes()` an out-of-bounds slice or non-existent file will throw an `ENOENT` error.
**Action:** Always prefer `Bun.file(path).slice(start).bytes()` for incremental file processing. Compute file size manually beforehand with `const size = Bun.file(path).size` to safely prevent out-of-bounds reads, while retaining a `try/catch` block around the read operation to handle `ENOENT` correctly.
