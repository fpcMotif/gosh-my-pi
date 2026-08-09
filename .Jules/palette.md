## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2024-05-10 - [Global Focus Visible Outline]
**Learning:** Adding a global `*:focus-visible` outline is an extremely efficient and maintainable way to ensure baseline keyboard accessibility across a web app without having to add utility classes (e.g. `focus-visible:ring-2`) to every interactive component individually.
**Action:** Always check if a global focus visible rule exists before trying to add utility classes individually to buttons or inputs, unless a specific component requires a custom focus ring style.

## 2024-05-16 - Add Click-Outside-To-Close for Native Dialogs

**Learning:** When using native HTML `<dialog>` elements, clicking on the backdrop doesn't close the modal by default. This missing interaction can frustrate users who expect standard modal behavior. Checking `e.target === dialogRef.current` in the `onClick` handler is a robust way to implement this because the backdrop click registers on the dialog itself, while clicks inside the dialog content register on the inner container.
**Action:** Always add an `onClick` handler to `<dialog>` elements that checks `if (e.target === dialogRef.current) onClose();` to ensure users can dismiss modals by clicking the backdrop.
