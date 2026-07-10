
## 2024-07-10 - Status Icons Accessibility
**Learning:** Icon-only status indicators (like checkmarks or cross symbols in tables) can be confusing for screen readers when they aren't properly annotated, despite being obvious visually.
**Action:** Always wrap icon-only status indicators in a semantic element (like `span`) containing `role="img"`, `aria-label`, and `title` attributes, while adding `aria-hidden="true"` to the inner SVG itself to prevent redundant or confusing screen reader announcements.
