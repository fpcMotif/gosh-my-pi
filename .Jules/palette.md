## 2024-05-15 - Add Keyboard Shortcut to Dismiss Modal

**Learning:** Modals should be easily dismissable via keyboard (e.g., using the Escape key) to enhance usability and accessibility. Additionally, providing tooltip hints (using the `title` attribute) on close buttons makes these keyboard shortcuts discoverable to users.
**Action:** Always add keyboard event listeners for 'Escape' to dismiss modals or popovers, and add `title` and `aria-label` attributes to icon-only buttons for both screen reader support and tooltip discovery.
## 2024-05-10 - [Global Focus Visible Outline]
**Learning:** Adding a global `*:focus-visible` outline is an extremely efficient and maintainable way to ensure baseline keyboard accessibility across a web app without having to add utility classes (e.g. `focus-visible:ring-2`) to every interactive component individually.
**Action:** Always check if a global focus visible rule exists before trying to add utility classes individually to buttons or inputs, unless a specific component requires a custom focus ring style.
## 2024-05-17 - Dismiss Native Dialog via Backdrop Click

**Learning:** Native HTML `<dialog>` elements do not automatically close when the user clicks on the backdrop (outside the modal dialog box). This causes confusion for users who expect a standard dismissable modal experience when clicking away.
**Action:** When using a native `<dialog>` element for a modal, always add an `onClick` event handler to check if the click target is the dialog element itself (`e.target === dialogRef.current`) and close the dialog to ensure intuitive interaction behavior.
