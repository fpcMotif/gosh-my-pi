## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-23 - Table Row Keyboard Accessibility
**Learning:** Custom interactive elements (like `<tr onClick>`) require manual keyboard accessibility. It's critical to avoid using `role="button"` on table rows as it overrides native table semantics.
**Action:** When making `<tr>` interactive, use `tabIndex={0}` and add an `onKeyDown` handler for 'Enter'/'Space' keys (calling `e.preventDefault()` on Space to prevent scrolling). Use `focus-visible` utility classes for visual focus states.
