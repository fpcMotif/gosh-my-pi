## 2025-07-15 - Accessible Status Indicators in Tables
**Learning:** Icon-only status indicators in tables (e.g., success/error icons) are confusing for screen readers and lack visual tooltips for mouse users when not properly labeled.
**Action:** When implementing icon-only status indicators in tables, wrap the icon in a semantic element containing a `title` (for mouse hover) and `aria-label` along with `role="img"`. Apply `aria-hidden="true"` to the inner SVG or Lucide icon itself.
