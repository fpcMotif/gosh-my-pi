## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-06-25 - React Chart Performance
**Learning:** In react-chartjs-2, creating inline `chartData` or `options` objects directly inside list/table rows causes severe performance degradation because React re-renders the chart component on every parent state change (like expanding a row), leading to expensive Canvas repaints.
**Action:** Always wrap chart components in `React.memo` and their `data` / `options` objects in `useMemo` to enforce stable object references. Extract inline default arrays (e.g., `?? []`) to module-level constants to prevent breaking memoization.
