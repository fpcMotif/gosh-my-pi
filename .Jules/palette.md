## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-06 - Manual Keyboard Accessibility for Semantic Elements

**Learning:** When adding interactability (like onClick handlers) to semantic HTML elements that are not inherently interactive (e.g., `<tr>`), adding keyboard accessibility requires manual implementation using `tabIndex` and `onKeyDown` instead of relying on `role="button"`. Using `role="button"` on a `<tr>` overwrites native table semantics, which negatively affects screen readers navigating the table structure.
**Action:** When making custom components or semantic non-interactive elements like `<tr>` interactive, always manually implement keyboard support: add `tabIndex={0}`, handle both 'Enter' and 'Space' keys in `onKeyDown` (preventing default for Space to stop page scrolling), and add clear `focus-visible` styles without changing the element's ARIA role.
