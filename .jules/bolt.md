## 2025-06-08 - Fast Appended File Reading in Bun

**Learning:** When extracting trailing bytes or specific sections from large files in Bun (like reading appended logs in `.jsonl` session files), using `await Bun.file(path).bytes()` loads the entire file into memory before taking a subarray. This creates a significant execution bottleneck and memory allocation overhead.
**Action:** Always prefer `await Bun.file(path).slice(start).bytes()` when reading partial file data, as it only loads the requested bytes directly from disk, drastically reducing memory usage and execution time.
