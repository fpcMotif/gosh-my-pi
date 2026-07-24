## 💡 What
Added an `onClick` event handler to the `<dialog>` element in `RequestDetail.tsx` to enable clicking the modal backdrop to dismiss the dialog.

## 🎯 Why
Native HTML `<dialog>` elements do not automatically close when users click on their backdrop pseudo-element. Users commonly expect this behavior (clicking outside the content to close a modal). This small enhancement makes the interaction feel more natural and intuitive.

## 📸 Before/After
**Before:** Clicking outside the modal content area did nothing. The user had to click the close (X) button or press the Escape key.
**After:** Clicking outside the modal content area now closes the modal.

## ♿ Accessibility
While this primarily improves usability for mouse users, keyboard accessibility (via the Escape key) remains intact and functional. It reduces the interaction cost for mouse users who no longer need to precisely target the close button.
