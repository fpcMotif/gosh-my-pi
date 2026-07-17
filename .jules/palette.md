## 2024-07-17 - [Accessible Tooltips for Icon-only Indicators]
**Learning:** In data-dense tables, icon-only status indicators save space but can hide critical context (like the exact error message) and confuse screen readers. Exposing the error string via a native tooltip solves both problems elegantly.
**Action:** Wrap icon-only status indicators in a semantic element with `role="img"`, `aria-label`, and `title` (binding actual error data when available), while hiding the raw SVG from screen readers with `aria-hidden="true"`.
