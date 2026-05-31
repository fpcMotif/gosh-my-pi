## 2024-05-31 - [Promise.all vs Sequential Await]
**Learning:** Found multiple instances where independent promises were awaited sequentially in a `for...of` loop instead of using `Promise.all()`. This can cause significant performance bottlenecks in I/O operations like module loading or filesystem access. Specifically in `packages/coding-agent/src/extensibility/custom-tools/loader.ts`.
**Action:** Replace `for...of` with `Promise.all()` when independent async operations occur in a loop.
