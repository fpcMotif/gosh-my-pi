## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-07-06 - Interactive Table Row Accessibility

**Learning:** When using custom interactive elements like `onClick` handlers on `<tr>` elements instead of actual buttons, they are inherently inaccessible via keyboard navigation, breaking core accessibility standards. Users cannot tab to them or interact with them using 'Enter' or 'Space'.
**Action:** Always implement manual keyboard accessibility for custom interactive elements by adding `tabIndex={0}`, an `onKeyDown` handler that mimics the click for 'Enter'/'Space' (including `e.preventDefault()` on Space to stop page scrolling), and clear `focus-visible` utility classes using design system colors (e.g., `focus-visible:ring-[var(--accent-cyan)]`). Avoid using `role="button"` on `<tr>` to preserve table semantics.
