## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2026-06-04 - Focus visibility for clickable table rows
**Learning:** In the stats UI, clickable table rows (`<tr onClick={...}>`) lacked proper focus styles and keyboard support, making them inaccessible.
**Action:** Always add `role="button"`, `tabIndex={0}`, `onKeyDown` handlers (for Enter/Space), `aria-label`, and `focus-visible` utility classes to make custom interactive elements accessible.
