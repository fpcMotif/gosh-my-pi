## 2026-05-26 - [Backend Promise Coalescing]
**Learning:** The frontend dashboard triggers multiple concurrent backend API requests that cause redundant, heavy DB/file IO ops because each calls `syncAllSessions()`.
**Action:** Use a promise coalescing (deduplication) pattern for such state-synchronizing tasks. Ensure to document the pattern well with comments as required by guidelines.
