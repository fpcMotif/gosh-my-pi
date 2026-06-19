## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-19 - Clickable Table Rows Accessibility
**Learning:** Making non-interactive elements like `<tr>` clickable requires manual implementation of interactive semantics and behaviors. Do not add `role="button"` as it overrides native screen reader semantics for table rows.
**Action:** Instead, ensure keyboard accessibility by adding `tabIndex={0}` to make the row focusable, an `onKeyDown` handler that triggers the action on 'Enter' and 'Space', an appropriate `aria-label`, and `focus-visible` styling to clearly indicate focus state without relying on mouse hover.
