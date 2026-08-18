## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2024-05-10 - [Global Focus Visible Outline]
**Learning:** Adding a global `*:focus-visible` outline is an extremely efficient and maintainable way to ensure baseline keyboard accessibility across a web app without having to add utility classes (e.g. `focus-visible:ring-2`) to every interactive component individually.
**Action:** Always check if a global focus visible rule exists before trying to add utility classes individually to buttons or inputs, unless a specific component requires a custom focus ring style.
## 2024-08-18 - Dialog Backdrop Click Dismissal
**Learning:** Native HTML `<dialog>` elements do not automatically close when a user clicks the backdrop overlay. This can trap users in modals if they expect clicking outside the content to close it, which is a very common UX pattern.
**Action:** Always add an `onClick` handler to the `<dialog>` that checks `if (e.target === dialogRef.current)` and calls the close function to enable intuitive backdrop dismissals.
