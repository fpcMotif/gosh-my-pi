## 2025-05-19 - [Memory Consolidation Parallelization]
**Learning:** In `packages/coding-agent/src/memories/index.ts`, core asynchronous I/O loops (e.g. `pruneEmptyDirectories`, `listRelativeFiles`, and skill writing loops) were running sequentially, acting as a performance bottleneck during memory compaction operations.
**Action:** Always prefer parallelizing independent I/O operations using `Promise.all` and `Array.prototype.map` instead of sequential `for` loops with `await`, unless operations have strict dependency order.
