## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## YYYY-MM-DD - Memoize React Chart.js components in lists
**Learning:** In `react-chartjs-2`, creating inline `chartData` or `options` objects inside list/table rows causes severe performance degradation due to React re-rendering the chart on every parent state change (e.g. expanding an accordion).
**Action:** Wrap chart components in `React.memo` and their data/options in `useMemo` to enforce stable object references. Additionally, extract inline default arrays (e.g., `?? []`) to module-level constants to prevent breaking memoization.
