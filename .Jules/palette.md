## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-16 - Make Clickable Table Rows Keyboard Accessible
**Learning:** When using `onClick` on non-interactive elements like `<tr>` for navigation or revealing details, it breaks accessibility for keyboard users because these elements cannot be focused or activated with the keyboard.
**Action:** Always add `tabIndex={0}`, an `onKeyDown` handler to support "Enter" and "Space" keys, and provide a clear visual focus indicator (e.g., using `focus-visible` Tailwind classes) when making semantic but non-interactive elements like `<tr>` clickable.
