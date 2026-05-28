## 2024-05-28 - Custom Tool Loader Optimization
**Learning:** `CustomToolLoader.load` loads tool modules sequentially in a `for...of` loop which can be a bottleneck when multiple custom tools are present. Since custom tool loading is I/O bound (module import and potential async factory execution), these can be parallelized.
**Action:** Use `Promise.all` to load custom tools concurrently in `CustomToolLoader.load`.
