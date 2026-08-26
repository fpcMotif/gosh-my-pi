## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-08-26 - react-chartjs-2 Re-rendering Pitfall
**Learning:** In `react-chartjs-2`, creating inline `chartData` or `options` objects inside list/table rows causes severe performance degradation due to React re-rendering the chart on every parent state change (like expanding a row). Wrapping chart components in `React.memo` and their data/options in `useMemo` enforces stable object references. Extracting inline default arrays (e.g., `?? []`) to module-level constants (typed as `never[]`) also prevents breaking memoization.
**Action:** Always memoize `chartData` and `options` props passed to `react-chartjs-2` components, wrap custom chart wrappers in `React.memo`, and extract inline default fallback arrays.
