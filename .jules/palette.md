## 2023-10-25 - Accessible Icon-Only Status Indicators
**Learning:** Screen readers often announce raw SVGs or Lucide icons confusingly, and mouse users lack context for icon-only status columns in tables (like success/error icons).
**Action:** Always wrap icon-only status indicators in a semantic element (like `span`) with `title`, `aria-label`, and `role="img"`, while applying `aria-hidden="true"` to the SVG itself.
