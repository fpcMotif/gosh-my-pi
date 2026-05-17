## 2024-05-15 - Keyboard accessibility for custom interactive elements
**Learning:** Interactive table rows (`<tr onClick>`) lack native interactive semantics. Unlike `<button>` or `<a>`, they don't natively receive focus or trigger clicks via keyboard.
**Action:** When making custom non-interactive elements clickable, always add `tabIndex={0}`, handle keyboard events (`Enter` and `Space`), and provide visible focus states (`focus-visible:ring-2` etc.) for accessibility.
