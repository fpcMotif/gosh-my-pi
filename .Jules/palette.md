## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-13 - [Stats Dashboard Accessibility]

**Learning:** Found an accessibility improvement in the stats dashboard where active tabs in the Header don't use the `aria-current="page"` (or "true") attribute to indicate the active state to screen readers. They only use a CSS class `active`.
**Action:** Adding `aria-current="page"` to active tabs.
