## 2024-05-24 - Custom interactive elements need manual keyboard support
**Learning:** When using custom interactive elements (like `<tr onClick>`) in a React frontend, they must implement manual keyboard accessibility. This means adding `tabIndex={0}` and an `onKeyDown` handler to capture the 'Enter' and 'Space' keys.
**Action:** Always add keyboard event handlers and visual focus styles (e.g. `focus-visible` utility classes) when assigning click handlers to non-interactive HTML elements.
