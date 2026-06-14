## 2026-06-14 - Optimize parsing appended data in JSONL files
**Learning:** In Bun, loading the entire file into memory via `await Bun.file(path).bytes()` and then slicing it with `.subarray(start)` is inefficient for large files that append data over time.
**Action:** Use `Bun.file(path).slice(start).bytes()` to extract only the trailing bytes, computing bounds manually via `Bun.file(path).size` while keeping the read within a try/catch block to safely handle `ENOENT` and avoid TOCTOU errors.
