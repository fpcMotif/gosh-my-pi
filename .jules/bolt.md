## 2024-06-30 - Avoid Loading Large Files into Memory for Subarray Operations

**Learning:** When needing to read only the end of a large file (e.g. parsing appended data in `.jsonl` files), using `await Bun.file(path).bytes()` and then `.subarray(start)` reads the entire file into memory first, which takes hundreds of milliseconds for large files. `Bun.file(path).slice(start).bytes()` handles reading from the offset natively, which is nearly instantaneous.

**Action:** Prefer `Bun.file(path).slice(start).bytes()` over `.bytes().subarray(start)` for extracting specific sections or trailing bytes from large files. Compute the size manually via `Bun.file(path).size` and retain `try/catch` around `.bytes()` for `ENOENT` handling.
