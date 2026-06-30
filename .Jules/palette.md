## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-30 - Keyboard Accessibility on Interactive Table Rows
**Learning:** Custom interactive elements, such as `<tr>` elements with `onClick` handlers used in lists or tables, are completely invisible to keyboard users by default. This makes critical features like selecting an item impossible without a mouse. Applying native semantics where possible is best, but when custom markup is necessary, it requires manual keyboard event wiring and focus management.
**Action:** Always verify that elements with `onClick` handlers also have a corresponding `tabIndex={0}` to be focusable, an `onKeyDown` handler to listen for 'Enter' and 'Space' keys (with `e.preventDefault()` on Space to prevent page scrolling), and clear visual focus indicators using utility classes like `focus-visible:ring-2`.
