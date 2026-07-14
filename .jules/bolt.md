## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2025-02-18 - Concurrent Loader I/O
**Learning:** In configuration discovery modules (e.g., `packages/coding-agent/src/discovery/builtin.ts`), sequentially looping over directory lists using `for...of` with `await` introduces significant initialization latency. Refactoring to parallelize directory I/O using `.map()` and `Promise.all()` bounds the time by the slowest read, but care must be taken to subsequently loop over the results sequentially to preserve fallback/override order.
**Action:** Apply `Promise.all()` to bounded arrays of directory promises and iterate over the resolved values sequentially whenever strict configuration precedence is required.
