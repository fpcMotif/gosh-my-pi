## 2025-02-12 - Semantic Wrapping for Icon-Only Status Indicators
**Learning:** Icon-only status indicators (like those in tables) can be confusing for screen reader users if the raw SVG or Lucide icon is read directly. Hover states only work for mouse users, leaving keyboard and screen reader users without context.
**Action:** Always wrap icon-only indicators in a semantic element (e.g., `span`) with `role="img"`, `aria-label`, and `title`. Apply `aria-hidden="true"` to the inner SVG/icon to prevent confusing screen reader announcements.
