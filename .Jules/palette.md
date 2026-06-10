## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-10 - Keyboard Accessible Table Rows
**Learning:** Making non-interactive semantic HTML elements (like `<tr>`) clickable in React breaks native screen reader semantics if `role="button"` is added.
**Action:** Ensure keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an `aria-label`, and `focus-visible` styles without altering the role.
