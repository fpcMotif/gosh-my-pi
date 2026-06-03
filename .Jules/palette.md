## 2024-06-03 - Accessible Table Rows
**Learning:** When making `<tr>` elements interactive (e.g., using them as click targets for row selection), they lose default button accessibility. Keyboard users cannot focus on them, and screen readers do not announce them as interactive.
**Action:** Always add `role="button"`, `tabIndex={0}`, an `onKeyDown` handler (listening for `Enter` and `Space`), a descriptive `aria-label`, and `focus-visible` styles to interactive table rows to ensure they are accessible.
