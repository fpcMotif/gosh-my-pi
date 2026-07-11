## 2024-05-14 - [Accessible Status Icons]
**Learning:** Found that purely visual icons used as status indicators (like XCircle and CheckCircle2 in tables) are not announced by screen readers or explained to visually impaired users.
**Action:** Always wrap visual status icons in a semantic element (like `span` or `div`) containing a `title` (for mouse hover tooltips), an `aria-label`, and `role="img"`. Additionally, explicitly apply `aria-hidden="true"` to the inner SVG or Lucide icon component itself to prevent confusing screen reader announcements.
