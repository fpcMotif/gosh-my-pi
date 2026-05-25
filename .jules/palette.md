## 2024-05-25 - Custom Interactive Table Rows
**Learning:** Custom interactive elements (e.g., `<tr onClick>`) in this app's React frontend need manual keyboard accessibility to be usable by everyone.
**Action:** Always add `tabIndex={0}`, an `onKeyDown` handler for 'Enter'/'Space' keys, and `focus-visible` utility classes (like `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-cyan)] outline-none`) to provide clear visual focus states for custom interactive elements.
