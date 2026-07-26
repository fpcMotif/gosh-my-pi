## 2024-07-26 - Accessible Icon-Only Status Indicators
**Learning:** Icon-only status indicators in tables (like success/error icons) need specific accessibility attributes to be properly announced by screen readers and understood by users on hover.
**Action:** Wrap the icon in a semantic element (like a `span` or `div`) containing a `title` (for mouse hover) and `aria-label` along with `role="img"`. Apply `aria-hidden="true"` to the inner SVG or Lucide icon itself.
