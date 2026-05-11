## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2026-05-11 - Make Interactive Table Rows Keyboard Accessible
**Learning:** Interactive list/table items (like rows with `onClick` handlers) must be accessible via keyboard navigation. Sighted users can click anywhere on the row, but keyboard users cannot interact with it unless it receives focus.
**Action:** Add `tabIndex={0}` to make the element focusable, provide a visual focus state (e.g., matching the hover state), and add an `onKeyDown` handler to trigger the action when `Enter` or `Space` is pressed. Add an `aria-label` or `aria-labelledby` for screen reader context if the row's content alone isn't clear enough.
