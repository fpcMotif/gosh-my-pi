## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-04 - Accessible Custom Interactive Table Rows

**Learning:** When making `<tr>` elements clickable (e.g., using `onClick`), adding `role="button"` breaks native table semantics for screen readers. Instead, we must manually implement keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys (calling `e.preventDefault()` on Space to prevent page scrolling), and `focus-visible` utility classes for clear visual focus states, while leaving the default table roles intact.
**Action:** For interactive table rows, add `tabIndex={0}`, a keyboard handler, and `focus-visible` classes (like `focus-visible:ring-2`), and intentionally avoid using `role="button"`.
