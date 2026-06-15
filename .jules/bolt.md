## 2024-06-15 - Fast Append Parsing using `Bun.file().slice().bytes()`

**Learning:** Reading heavily appended `.jsonl` session files was unnecessarily allocating memory for the entire file before subarraying the new entries. `Bun.file(path).slice(start).bytes()` successfully streams only the new bytes without loading the entire file.

**Action:** When extracting unparsed appended logs, use `Bun.file(path).slice(start).bytes()` and explicitly query `Bun.file(path).size` to avoid out-of-bounds reads and memory bottlenecks.
