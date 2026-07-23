## 2024-07-23 - Accessibility for Icon-only Status Indicators
**Learning:** Icon-only status indicators (like success/error icons in a table) are not readable by screen readers unless properly labeled with an aria-label and role, and the icon itself is hidden from screen readers.
**Action:** When implementing icon-only status indicators, wrap the icon in a semantic element (like a `span` or `div`) containing a `title` (for mouse hover) and `aria-label` along with `role="img"`. Apply `aria-hidden="true"` to the inner SVG or Lucide icon itself to prevent confusing screen reader announcements.
