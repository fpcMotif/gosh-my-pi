## 2024-07-30 - Accessible Icon-Only Status Indicators
**Learning:** Screen readers announce SVGs in icon-only status indicators unpredictably unless properly wrapped.
**Action:** Always wrap icon-only status indicators in a semantic element with `role="img"`, `title`, and `aria-label`, and apply `aria-hidden="true"` to the inner SVG icon to prevent confusing screen reader announcements.
