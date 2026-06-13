## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2025-06-13 - [Make Table Rows Keyboard Accessible]
**Learning:** In React, adding an `onClick` handler to a `<tr>` element makes it interactive for mouse users but completely inaccessible for keyboard users, preventing them from accessing row details.
**Action:** When making semantic, non-interactive elements like `<tr>` clickable, always add `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space' (using `e.preventDefault()` on 'Space' to prevent scrolling), an `aria-label`, and visual focus styles (`focus-visible` classes) to ensure full accessibility. Do not add `role="button"` to table rows as it interferes with native screen reader table semantics.
