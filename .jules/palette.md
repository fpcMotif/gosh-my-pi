## 2024-06-15 - Initial setup

## 2024-06-15 - Make Request List rows keyboard accessible
**Learning:** The `<tr onClick>` elements used in RequestList need manual accessibility updates. It is important to add `tabIndex={0}`, `onKeyDown` handlers mapping 'Enter' and 'Space' to clicks, and tailwind focus-visible ring classes to ensure correct navigation and visual focus via keyboard.
**Action:** Use this pattern whenever interactive lists or tables with custom click actions are encountered in the project.
