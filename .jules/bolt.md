## 2024-06-26 - Avoid unnecessary memory allocation on large incremental file reads

**Learning:** When incrementally reading newly appended JSONL entries from a large file using `parseSessionFile`, loading the entire file via `await Bun.file(path).bytes()` and then using `.subarray(start)` allocates memory for the entire file. This can be extremely slow and memory-intensive for large session logs.
**Action:** Use `Bun.file(path).size` to compute bounds, and `await Bun.file(path).slice(start).bytes()` to only read and load the required trailing chunk into memory. Add a fallback try/catch to safely handle `ENOENT` if the file does not exist.
