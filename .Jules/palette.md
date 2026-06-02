## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-20 - Ensure Keyboard Accessibility on Table Rows

**Learning:** Custom interactive elements (e.g., `<tr onClick>`) in the React frontend must implement manual keyboard accessibility, but without overriding native semantics (do not use `role="button"` on a `<tr>`).
**Action:** When adding `onClick` to `<tr>`, ensure you also add `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys to trigger the action, an `aria-label` or wrapping cells for screen readers, and `focus-visible` utility classes for clear visual focus states.
