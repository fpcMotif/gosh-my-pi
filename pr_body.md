💡 What: Added manual keyboard navigation support to the interactive table rows in the `RequestList` component.

🎯 Why: Custom interactive elements (like `<tr onClick>`) are not accessible by default to keyboard users. This change allows users navigating via keyboard (using the Tab key) to focus and select request entries to view their details using the Enter or Space keys.

📸 Before/After: Visual focus states (`focus-visible:ring-2`) now appear around the row when navigating via keyboard, making it clear which entry is currently focused.

♿ Accessibility:
- Added `tabIndex={0}` to make the rows focusable.
- Added an `onKeyDown` handler that triggers the selection upon pressing 'Enter' or 'Space'.
- Prevented default page scrolling behavior when pressing the 'Space' key while focused on a row.
- Added Tailwind `focus-visible` utility classes mapped to existing design system variables to provide clear visual feedback without affecting mouse users.
- Intentionally avoided overriding native table semantics (i.e. did not use `role="button"` on `<tr>`) as it would break screen reader table announcements.
