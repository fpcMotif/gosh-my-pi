## 2024-05-24 - Accessible Icon Status Indicators
**Learning:** Icon-only status indicators in tables can be skipped or confusingly announced by screen readers without semantic wrappers and accessible labels.
**Action:** Always wrap status icons in elements with `role="img"`, `aria-label`, and `title`, and set `aria-hidden="true"` on the icon itself.
