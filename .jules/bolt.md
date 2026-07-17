## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-07-17 - Parallelize Configuration Loading
**Learning:** In `packages/coding-agent/src/discovery/builtin.ts`, loading configurations sequentially across multiple directories using a `for...of` loop causes unnecessary initialization latency. By switching to `Promise.all` mapping over the directories, we can parallelize the I/O-bound operations (reading files, parsing JSON/Markdown) while preserving the required precedence order by collecting results after all promises resolve.
**Action:** Use `Promise.all` for I/O bound loading operations across independent sources/directories before flattening the results.
