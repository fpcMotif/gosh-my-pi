## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2025-02-14 - Accessible Clickable Table Rows
**Learning:** When making non-interactive semantic HTML elements (like `<tr>`) clickable in React, do not add `role="button"` as it breaks native screen reader semantics for tables. Instead, ensure keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an `aria-label` describing the action, and `focus-visible` styles.
**Action:** Always verify keyboard focus and activation (Enter/Space) when adding `onClick` handlers to non-button elements, while preserving their native HTML semantics.
