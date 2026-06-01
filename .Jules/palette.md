## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-01 - Table Row Interactive Elements (RequestList)

**Learning:** Custom interactive elements (like `<tr>` used as clickable rows in a table) are not natively focusable or interactable via keyboard by default.
**Action:** When creating a custom interactive table row (or similar element), ensure manual keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler that intercepts 'Enter' and 'Space' keys to trigger the action (and prevents default scrolling behavior for Space), assigning `role="button"` (or another appropriate role) for screen readers, and applying `focus-visible` utility classes (e.g., `focus-visible:outline focus-visible:outline-2`) to provide a clear visual indicator when the element receives keyboard focus.
