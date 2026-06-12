## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-12 - Making Table Rows Clickable

**Learning:** When making semantic table rows (`<tr>`) clickable, adding `role="button"` completely removes the table semantics for screen readers (they just announce "button" and ignore the cells).
**Action:** For clickable table rows, keep the native `<tr>` role. Instead, add `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an appropriate `aria-label` for context, and clear `focus-visible` styles using utility classes to ensure both keyboard navigation and semantic structure are preserved.
