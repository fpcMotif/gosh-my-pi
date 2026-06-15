
## 2024-06-15 - React Memoization and Fluctuating Values
**Learning:** Computing fluctuating values like `Date.now()` outside of a `useMemo` block and passing them as dependencies breaks memoization on every render, causing unnecessary re-renders.
**Action:** Always compute fluctuating values (like time-based cutoffs) *inside* the `useMemo` block to ensure memoization works as intended and only recomputes when actual data dependencies change.
