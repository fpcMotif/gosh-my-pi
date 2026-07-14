## 2024-07-14 - Accessible Icon-Only Status Indicators
**Learning:** Screen readers announce inner SVG content unpredictably. Icon-only elements need a wrapper with semantic roles and accessible names while hiding the raw icon.
**Action:** Wrap `XCircle`/`CheckCircle2` icons in a `span` containing `title`, `aria-label`, and `role="img"`. Apply `aria-hidden="true"` to the inner Lucide icon.
