## 2024-06-17 - React useMemo dependency on Date.now()
**Learning:** Using `Date.now()` (or any continuously changing value) in the body of a React component and passing it as a dependency to `useMemo` breaks memoization. The dependency changes on every render, causing expensive calculations (like filtering large `costSeries` arrays) to re-run unnecessarily.
**Action:** Always compute timestamp limits (like `Date.now() - X_DAYS`) inside the `useMemo` callback itself, and do not include `Date.now()` in the dependency array. This ensures memoization persists across re-renders.
