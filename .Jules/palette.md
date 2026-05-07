## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-16 - Make Interactive Table Rows Keyboard Accessible
**Learning:** Interactive table rows (`<tr onClick={...}>`) are often missed for keyboard accessibility. They need focus states and keyboard event listeners to be fully accessible. Adding `tabIndex={0}` allows them to receive focus, but they also need visual feedback and keyboard interaction.
**Action:** Always add `tabIndex={0}`, an `onKeyDown` handler (listening for 'Enter' or 'Space'), and `focus-visible` classes (like `focus-visible:outline-none focus-visible:bg-[var(--bg-hover)]`) to make interactive elements accessible without breaking the design.
