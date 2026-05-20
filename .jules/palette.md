## 2024-05-24 - Interactive TR Elements Need Manual Accessibility

**Learning:** Custom interactive elements (e.g., `<tr onClick>`) in React do not receive keyboard focus or events by default, unlike semantic interactive elements like `<button>`.

**Action:** Whenever using a non-interactive element like `<tr>` or `<div>` as an interactive button, always implement manual keyboard accessibility by:
1. Adding `tabIndex={0}` to make it focusable.
2. Adding an `onKeyDown` handler to trigger the action on 'Enter' or 'Space' keys.
3. Adding visual focus states, ideally with `focus-visible` utility classes (e.g. `focus-visible:ring-2`) to avoid showing focus styles to mouse users while supporting keyboard users.
