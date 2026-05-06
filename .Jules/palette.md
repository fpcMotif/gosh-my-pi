# Palette's Journal

## 2024-05-01 - [Add ARIA labels to icon-only buttons]
**Learning:** Screen readers cannot infer the purpose of icon-only buttons without an `aria-label` or visually hidden text. The `RequestDetail` component has a close button that uses the `X` icon from `lucide-react` but lacks an accessible name.
**Action:** Always add `aria-label` to icon-only buttons to ensure they are accessible to assistive technologies.

## 2024-05-01 - [Interactive table rows need full keyboard support]
**Learning:** Table rows (`tr`) with `onClick` handlers are invisible to keyboard users. To make them accessible, they need `tabIndex={0}`, an `onKeyDown` handler to listen for "Enter" or "Space" to trigger the same action, and a `role="button"` indicator. They also need focus-visible styles.
**Action:** When making a non-interactive element interactive (like a `div` or `tr`), always ensure it has `tabIndex`, keyboard event handlers, appropriate ARIA roles, and focus styles.
