## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-17 - [Make Interactive Table Rows Accessible]
**Learning:** [When making non-interactive semantic HTML elements like `<tr>` clickable in React using `onClick`, they lack native screen reader semantics and keyboard accessibility. Screen readers won't announce them as interactive, and keyboard users cannot focus or activate them.]
**Action:** [Ensure keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an `aria-label`, and `focus-visible` styles without altering the native semantics by adding `role="button"`.]
