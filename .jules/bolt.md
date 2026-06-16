## 2024-06-16 - Date.now() Breaking Memoization
**Learning:** Calling fluctuating values like `Date.now()` outside of a `useMemo` block and passing them as dependencies breaks memoization on every render because they generate a new value each time.
**Action:** Compute such fluctuating values inside the `useMemo` block instead to preserve memoization and prevent unnecessary re-renders.
