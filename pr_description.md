💡 What: Added keyboard navigation (`tabIndex`, `onKeyDown`) and focus visibility (`focus-visible` classes) to the interactive rows within `RequestList.tsx`.
🎯 Why: Previously, users relying on keyboard navigation could not focus or activate the table rows to view request details, preventing them from accessing full analytics data.
📸 Before/After: Before, hitting "Tab" skipped the entire list. Now, each row receives clear visual focus (cyan ring, light background) and can be opened with 'Enter' or 'Space'.
♿ Accessibility: Improved WCAG compliance by ensuring custom interactive elements provide manual keyboard accessibility support without overriding native table semantics.
