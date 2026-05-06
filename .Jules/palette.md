## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.

## 2024-05-16 - Add Placeholder Support to Input Component
**Learning:** Terminal User Interfaces (TUIs) benefit greatly from standard UI conventions like input placeholders. Implementing them requires careful handling of ANSI styling (e.g., dimming the text) while preserving cursor positioning logic.
**Action:** When creating text input fields in TUI components, always support a placeholder attribute to guide users on what input is expected, using distinct visual styling to differentiate it from actual input.
