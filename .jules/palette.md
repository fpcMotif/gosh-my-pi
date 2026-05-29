
## 2024-05-29 - [Keyboard Accessibility for Table Rows]
**Learning:** Custom interactive elements (like `<tr onClick>`) in this React frontend require explicit keyboard accessibility support. Simply adding an `onClick` handler is insufficient for users navigating via keyboard.
**Action:** When implementing custom interactive elements, always ensure manual keyboard accessibility by adding `tabIndex={0}`, an `onKeyDown` handler to capture 'Enter' and 'Space' keys, and `focus-visible` utility classes (e.g., `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-cyan)] focus-visible:bg-[var(--bg-hover)]`) to provide clear visual focus states.
