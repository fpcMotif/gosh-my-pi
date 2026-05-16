## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-11-20 - Interactive Table Rows Accessibility

**Learning:** When using standard HTML table rows (`<tr>`) as interactive, clickable elements (e.g. for opening a details view), they are not natively focusable or keyboard-accessible. Relying only on `onClick` excludes users navigating by keyboard, and custom focus-visible styles are needed because browsers don't provide strong default outlines for table rows. Furthermore, icon-only status indicators in table cells are frequently missed by screen readers without explicit `aria-label`s.
**Action:** Always add `tabIndex={0}`, an `onKeyDown` handler (for Enter and Space keys), and clear `focus-visible` ring utilities to interactive `<tr>` elements. Provide explicitly descriptive `aria-label`s to any icon-only indicators (like success or error status icons).
