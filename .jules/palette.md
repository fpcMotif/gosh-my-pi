
## 2024-07-20 - Add context and accessibility to status icons
**Learning:** Icon-only status indicators in tables (like success/error icons) need semantic meaning for screen readers and helpful context (like error messages) for visual users on hover, which wasn't previously available without clicking into the details.
**Action:** Always wrap icon-only indicators in a semantic element with `role="img"`, `aria-label`, and `title` attributes, while hiding the decorative icon itself from screen readers using `aria-hidden="true"`.
