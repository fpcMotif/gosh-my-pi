## 2024-06-12 - React Memoization Anti-pattern
**Learning:** Calling `Date.now()` outside of a `useMemo` block and passing it as a dependency breaks memoization because the value fluctuates on every render, causing expensive recalculations on components like CostSummary and CostChart.
**Action:** Compute fluctuating values like `Date.now()` inside the `useMemo` block and omit them from the dependency array.
