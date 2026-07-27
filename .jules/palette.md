## 2025-01-20 - Icon Accessibility
**Learning:** Found several icon-only or icon-dominant components (like table headers or button toggles) missing screen reader context or proper role/aria-hidden attributes, leading to unhelpful or confusing screen reader announcements.
**Action:** Always wrap icons with aria-hidden="true" in icon-only buttons, and provide visually hidden labels or aria-labels for context.
