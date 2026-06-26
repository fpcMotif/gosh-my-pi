## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2026-06-26 - RequestList Keyboard Accessibility
**Learning:** The `<tr onClick>` pattern in the React frontend (specifically in ) lacks native keyboard semantics, making it impossible for keyboard users to activate row items.
**Action:** Always implement manual keyboard accessibility for interactive elements by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space' (with `e.preventDefault()` on Space to stop scrolling), and applying `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cyan)] focus-visible:bg-[var(--bg-hover)]` to align with existing design system focus states.
## 2025-02-28 - RequestList Keyboard Accessibility
**Learning:** The `<tr onClick>` pattern in the React frontend (specifically in RequestList.tsx) lacks native keyboard semantics, making it impossible for keyboard users to activate row items.
**Action:** Always implement manual keyboard accessibility for interactive non-button elements by adding `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space' (with `e.preventDefault()` on Space to stop scrolling), and applying `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cyan)] focus-visible:bg-[var(--bg-hover)]` to align with existing design system focus states.
