## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2026-06-22 - Keyboard Accessibility on Custom Interactive Elements
**Learning:** Custom interactive elements (e.g., `<tr onClick>`) in the React frontend lack native keyboard support. Users cannot navigate to them using 'Tab' or activate them using 'Enter' or 'Space'. This breaks accessibility and smooth navigation.
**Action:** Add `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys (calling `e.preventDefault()` on Space to prevent page scrolling), and `focus-visible` utility classes for clear visual focus states. Do not use `role="button"` on `<tr>` elements to avoid overriding native table semantics.
