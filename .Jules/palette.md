## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-20 - Add Keyboard Support to List Items and Toggles
**Learning:** Table rows used as selectable items (`onClick`) and expandable elements (like toggles) are inaccessible to keyboard users unless explicitly made focusable and given keyboard event handlers. Furthermore, state-toggling elements need `aria-expanded` to communicate their current state to screen readers.
**Action:** When adding `onClick` handlers to non-button elements like `<tr>` or `<div>` that function as lists or interactive elements, always include `tabIndex={0}`, an `onKeyDown` handler that listens for "Enter" and " " (Space), descriptive `aria-label`s, and clear visual focus styles (`focus-visible:outline-none focus-visible:ring-2`). For toggle controls, add the `aria-expanded` attribute.
