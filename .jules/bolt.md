## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-08-15 - React ChartJS 2 List Performance Bottleneck
**Learning:** In `react-chartjs-2`, creating inline `chartData` or `options` objects inside list/table rows causes severe performance degradation due to React re-rendering the chart on every parent state change. Furthermore, using inline default arrays (e.g., `?? []`) breaks memoization by supplying a new array reference on each render.
**Action:** Always wrap chart components in `memo`, wrap their `data`/`options` in `useMemo`, and extract inline default arrays to module-level constants (e.g., `const EMPTY_ARRAY = []`).
