## 2024-05-29 - Optimize I/O bound initialization in tool loader
**Learning:** Initializing custom tools sequentially in `packages/coding-agent/src/extensibility/custom-tools/loader.ts` causes a performance bottleneck because the `loadTool` function has asynchronous I/O overhead.
**Action:** Use `Promise.all` with `.map()` instead of a standard `for...of` await loop when initializing multiple independent objects that require file system I/O or network requests.
