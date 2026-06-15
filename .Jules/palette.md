## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-15 - Keyboard Accessible Semantic Table Rows

**Learning:** When making non-interactive semantic HTML elements (like `<tr>`) clickable in React, adding `role="button"` breaks native screen reader semantics for tables. Instead, ensuring keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an `aria-label`, and `focus-visible` styles provides a much better and compliant experience.
**Action:** Always ensure keyboard navigation and visible focus states are present on clickable semantic elements, preserving their native roles while making them fully accessible.
