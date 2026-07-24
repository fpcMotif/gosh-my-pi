## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-07-24 - React-Chartjs-2 Re-render Penalty
**Learning:** In `react-chartjs-2`, passing inline `chartData` or `options` objects (or inline default arrays like `?? []`) inside list/table rows causes severe performance degradation, because React re-renders the chart on every parent state change, breaking internal memoization.
**Action:** Always wrap chart components in `React.memo` and their `data`/`options` props in `useMemo` to enforce stable object references. Extract default arrays to module-level constants.
