## 2024-06-18 - Memoize fluctuating Date.now() correctly
**Learning:** Using `Date.now()` directly inside a React component block (outside a memoized block) breaks memoization because the component block recalculates the value and dependencies using the new timestamp on every render.
**Action:** Compute fluctuating values like `Date.now()` inside the `useMemo` block itself to correctly skip re-evaluation on unnecessary re-renders.
