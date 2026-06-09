## 2024-06-09 - React useMemo Memoization Breakage
**Learning:** Calling fluctuating values like `Date.now()` outside of a `useMemo` block and passing them as dependencies breaks memoization on every render because the value is always changing.
**Action:** Compute fluctuating values like `Date.now()` or `Math.random()` inside the `useMemo` block to ensure the hook correctly memoizes based on actual props/state changes instead of time.
