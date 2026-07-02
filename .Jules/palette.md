## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-16 - Make Custom Interactive Table Rows Accessible
**Learning:** Custom interactive elements like `<tr onClick>` inherently lack keyboard focus and event handling (unlike semantic `<button>` or `<a>` elements). While using a role like `role="button"` might seem tempting, applying it to a `<tr>` overrides its native table semantics and can confuse screen readers.
**Action:** When making custom interactive elements (such as `<tr>`) accessible, manually implement keyboard support: add `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys (using `e.preventDefault()` on Space to prevent page scrolling), and `focus-visible` utility classes for clear visual focus states, while avoiding the `role="button"` override on inherently semantic layout elements.
