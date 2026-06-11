## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-11 - Making Interactive TR Elements Accessible
**Learning:** Making `<tr>` elements clickable with `onClick` without accessibility metadata breaks screen reader semantics and keyboard navigation. Using `role="button"` on `<tr>` completely removes native table semantics (e.g., column headers are no longer announced correctly).
**Action:** Always maintain native HTML table structure. Instead of changing roles, add `tabIndex={0}`, an `onKeyDown` handler that mimics the `onClick` event on 'Enter' and 'Space', an explicit `aria-label`, and `focus-visible` styles on the `<tr>` element.
