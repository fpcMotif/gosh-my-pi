## 2024-05-18 - Avoid calling Date.now() in useMemo dependencies
**Learning:** In React, passing fluctuating values like `Date.now()` in the dependency array or using them immediately before `useMemo` and depending on them causes the memoization to break on every render since the value is always different.
**Action:** Compute such fluctuating values strictly inside the `useMemo` factory callback so that the cache is only invalidated when actual dependencies change.
