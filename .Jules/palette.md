## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-07-01 - Interactive Element Keyboard Accessibility Pattern
**Learning:** Custom interactive elements (e.g., `<tr onClick>`) in React must explicitly implement keyboard interaction handlers and visual focus states to be accessible for non-mouse users.
**Action:** When creating custom interactive elements (like clickable table rows), add `tabIndex={0}`, an `onKeyDown` handler that triggers the action on 'Enter' or 'Space' (using `e.preventDefault()` on Space to prevent page scroll), and visual `focus-visible` CSS utility classes.
