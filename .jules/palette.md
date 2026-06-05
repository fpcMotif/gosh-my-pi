## 2024-06-05 - Accessibility Pattern for Interactive Table Rows
**Learning:** Custom interactive elements (e.g., `<tr onClick>`) must implement manual keyboard accessibility. Do not use `role="button"` on `<tr>` elements to avoid overriding native table semantics.
**Action:** Add `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys (calling `e.preventDefault()` on Space to prevent page scrolling), and `focus-visible` utility classes for clear visual focus states.
