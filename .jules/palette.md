## 2025-02-28 - Accessible Status Icons with Tooltips
**Learning:** Users often lack context on icon-only error status indicators in data tables without clicking into details. Screen readers also fail to announce these icons clearly without semantic wrapping and ARIA labels.
**Action:** Wrap status icons in a `<span role="img" aria-label="..." title="...">` and hide the SVG itself with `aria-hidden="true"`. Use the actual error message as the title for immediate hover context.
