## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-18 - Clickable Table Rows Keyboard Accessibility

**Learning:** When making semantic HTML elements like `<tr>` clickable using `onClick`, they do not automatically receive keyboard focus or respond to keyboard activation. Adding `role="button"` breaks native table semantics for screen readers. The best approach is to add `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an `aria-label`, and `focus-visible` utility classes to ensure both keyboard and screen reader accessibility without breaking the table structure.
**Action:** When implementing clickable table rows, prioritize adding `tabIndex`, keyboard event handlers, and focus styles instead of converting elements to buttons or using ARIA roles that disrupt semantic structure.
