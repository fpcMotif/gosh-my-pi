## 2024-06-13 - Avoid Fluctuating Values as useMemo Dependencies
**Learning:** Using fluctuating values like `Date.now()` outside of a `useMemo` block and passing them as dependencies completely breaks the performance benefits of memoization, as it causes the memoized value to be re-evaluated on every single render.
**Action:** Always compute fluctuating values like `Date.now()` directly *inside* the `useMemo` block if they are needed for the derived state calculation, rather than calculating them outside and passing them as dependencies.
