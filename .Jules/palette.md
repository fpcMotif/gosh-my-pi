## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2024-06-07 - Make Clickable Table Rows Accessible

**Learning:** When turning non-interactive elements like `<tr>` into clickable areas (e.g. adding an `onClick` handler to view details), it is critical to also make them fully keyboard accessible. However, adding `role="button"` to a `<tr>` is an ARIA anti-pattern because it destroys the semantic table structure for screen readers. The element should remain a row while supporting keyboard navigation.
**Action:** Add `tabIndex={0}`, an appropriate `aria-label`, an `onKeyDown` handler that accepts "Enter" and " " (space), and ensure clear visual `focus-visible` styling for keyboard accessibility, but NEVER override the native semantic `role` of table elements.
