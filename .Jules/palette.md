## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-06-18 - Making Semantic Table Rows Clickable

**Learning:** Adding `onClick` to a non-interactive semantic HTML element like `<tr>` creates an accessibility barrier for keyboard and screen reader users. Adding `role="button"` breaks native table semantics. To make a table row interactive without breaking table semantics, it needs `tabIndex={0}`, an `onKeyDown` handler for 'Enter' and 'Space', an `aria-label` describing the action, and clear `focus-visible` styling (using existing Tailwind utilities like `focus-visible:ring-2`).
**Action:** When making semantic elements (like `<tr>` or `<li>`) act as buttons, ensure they remain semantically correct while adding full keyboard interactivity (`tabIndex={0}`, `onKeyDown` for Enter/Space), screen reader context (`aria-label`), and visible focus states (`focus-visible`).
