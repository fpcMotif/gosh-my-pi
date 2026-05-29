## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2026-05-29 - Interactive Table Rows Accessibility
**Learning:** Interactive table rows that only use `onClick` omit keyboard and screen reader accessibility, excluding users from vital interaction flows.
**Action:** Add `tabIndex={0}`, `onKeyDown` listeners for Space/Enter, `focus-visible` utility classes, and `aria-label` contextual tags to ensure all interactive elements are fully accessible.
