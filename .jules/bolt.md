## 2026-06-21 - Date.now() in React Components
**Learning:** In React components, avoid calling fluctuating values like `Date.now()` outside of a `useMemo` block and passing them as dependencies, as this breaks memoization on every render.
**Action:** Compute such values inside the `useMemo` block instead so they do not unnecessarily trigger re-evaluations across renders.
