## 2024-05-24 - Semantic Wrapper for Icon-Only Status Indicators
**Learning:** Raw icons (like Lucide or SVG) inside table cells for status are invisible to screen readers and lack helpful tooltips on hover (which is especially painful when trying to read error messages without clicking).
**Action:** Wrapped status icons in a `span` with `role="img"`, `aria-label`, and `title` attributes (using the specific error message for errors) while adding `aria-hidden="true"` to the SVG itself.
