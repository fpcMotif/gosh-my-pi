## 2024-07-22 - Improved Accessibility for Icon-only Status Indicators
**Learning:** Status indicators in tables that rely solely on icons (like CheckCircle/XCircle) are not announced properly by screen readers and lack hover context for mouse users.
**Action:** When implementing icon-only status indicators, wrap the icon in a semantic element (`span` or `div`) containing a `title` (for mouse hover) and `aria-label` along with `role="img"`. Apply `aria-hidden="true"` to the inner SVG/icon to prevent confusing screen reader announcements.
