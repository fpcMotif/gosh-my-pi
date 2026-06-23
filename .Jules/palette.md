## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-23 - Interactive Table Row Focus States
**Learning:** Adding `onClick` handlers to `<tr>` elements makes them interactive but not accessible by default. They lack native keyboard focus and activation behavior, which is critical for screen reader and keyboard-only users.
**Action:** When making `<tr>` elements interactive (e.g., in `RequestList.tsx`), implement manual keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys (calling `e.preventDefault()` on Space to prevent page scrolling), and clear `focus-visible` utility classes using existing theme variables (like `focus-visible:ring-[var(--accent-cyan)]`). Avoid using `role="button"` to maintain native table semantics.
