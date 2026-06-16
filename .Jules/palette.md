## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2026-06-16 - Accessible Clickable Table Rows

**Learning:** When making non-interactive semantic HTML elements like `<tr>` clickable in React, adding `role="button"` breaks native screen reader semantics for tables.
**Action:** Instead of adding `role="button"`, ensure keyboard accessibility by only adding `tabIndex={0}`, an `onKeyDown` handler that triggers on 'Enter' or 'Space', an `aria-label`, and `focus-visible` styles (`focus-visible:ring-2 focus-visible:outline-none`) so keyboard users can navigate to and activate the row while preserving the table structure.
