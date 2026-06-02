## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-18 - Interactive Table Row Accessibility Trap
**Learning:** Table rows (`<tr>`) used as interactive elements (e.g., clicking to view details) often trap screen reader and keyboard-only users if they only rely on `onClick`. Users cannot navigate to the row using the Tab key, and even if they reach it, screen readers may not announce it as an interactive element.
**Action:** Always add `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space' to trigger the action, an `aria-label` describing the action (e.g., "View details for [item]"), and `focus-visible` styling (like `focus-visible:ring-2 focus:outline-none`) to any custom interactive component that acts as a button but isn't natively a `<button>`.
