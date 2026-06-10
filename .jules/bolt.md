## 2024-06-10 - Memoization broken by `Date.now()` outside `useMemo`
**Learning:** In React components, calling fluctuating values like `Date.now()` outside of a `useMemo` block and passing them as dependencies breaks memoization. The value of `Date.now()` changes on every render, causing the `useMemo` to invalidate and re-run its expensive computations unnecessarily.
**Action:** Compute fluctuating values like `Date.now()` *inside* the `useMemo` block instead. This ensures the memoized value only recalculates when actual stable dependencies (like data props) change.
