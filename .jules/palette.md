
## 2024-06-21 - Accessible Custom Interactive Table Rows
**Learning:** Using `<tr onClick>` for interactive table rows creates an accessibility barrier for keyboard users. Adding `role="button"` can override native table semantics, degrading the experience for screen reader users expecting tabular data.
**Action:** When making custom non-interactive elements like `<tr>` interactive, always implement manual keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler that supports 'Enter' and 'Space' (and calls `e.preventDefault()` on Space to prevent page scrolling), and clear `focus-visible` utility classes for visual focus states without altering the element's ARIA role.
