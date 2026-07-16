## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.

## 2024-05-18 - Chart.js Inline Object Performance
**Learning:** Creating inline `chartData` or `options` objects for `react-chartjs-2` components (like `<Line data={chartData} options={options} />`) causes severe performance degradation and unnecessary re-renders when placed inside large list views, especially when parent state changes (like expanding an accordion row). Chart.js requires stable references to avoid deep merging and re-rendering on every render cycle.
**Action:** Wrap `chartData` and `options` object constructions in `useMemo`, and wrap the chart component itself in `memo()` when rendered inside lists or tables. Define constant fallbacks like `EMPTY_DATA = []` instead of inline `[]` to maintain reference equality.
