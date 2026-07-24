## 2024-07-24 - Accessible icon-only status indicators

**Learning:** Icon-only status indicators in tables (e.g. success/error icons) need specific ARIA labeling because they don't have visual text and are easily ignored or misread by screen readers. Providing a tooltip (via the `title` attribute) also helps users who aren't familiar with the specific icon meaning understand it.
**Action:** Always wrap icon-only indicators in a semantic element (like `span`) with `role="img"`, `aria-label`, and `title`. Add `aria-hidden="true"` to the inner SVG or Lucide icon component itself to ensure screen readers only announce the semantic wrapper.
