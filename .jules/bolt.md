## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-08-19 - React Chart.js-2 Re-rendering Bottleneck
**Learning:** In `react-chartjs-2`, passing inline `chartData` or `options` objects to chart components inside lists/tables causes severe performance degradation, as it forces the chart to re-render on every parent state change (due to changing object references). Furthermore, inline default array fallback values (e.g. `?? []`) create new references on each render, breaking memoization of dependent components.
**Action:** Always wrap chart components in `memo`, wrap their `data` and `options` props in `useMemo`, and extract inline default fallback arrays to module-level constants (typed as `never[]`) to maintain stable references and optimize rendering performance.
