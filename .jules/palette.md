## 2024-07-21 - Accessible Icon-Only Status Indicators
**Learning:** Icon-only status indicators in tables (like CheckCircle2 or XCircle for Success/Error) are confusing for screen readers and lack mouse hover context when used directly.
**Action:** Wrap the icon in a semantic element (like a `span` or `div`) containing a `title` (for mouse hover) and `aria-label` along with `role="img"`. Apply `aria-hidden="true"` to the inner SVG or Lucide icon itself to prevent confusing screen reader announcements.
