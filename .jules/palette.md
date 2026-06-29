
## 2024-06-29 - Interactive Table Rows Accessibility
**Learning:** Custom interactive elements (e.g., `<tr onClick>`) in React must implement manual keyboard accessibility, as they lack semantic button behavior.
**Action:** Added `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space' keys (with `e.preventDefault()` on Space to prevent page scroll), and `focus-visible` utility classes for clear visual focus states without overriding native table semantics by using `role="button"`.
