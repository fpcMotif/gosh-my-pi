## 💡 What:
Implemented promise coalescing (request deduplication) in `packages/stats/src/aggregator.ts` for the `syncAllSessions` and `getDashboardStats` functions. This prevents multiple identical, concurrent requests from executing duplicate logic.

## 🎯 Why:
If the local observability dashboard (or external scripts polling the `/api/stats` and `/api/sync` endpoints) triggers multiple concurrent requests, each request would previously spawn its own full directory traversal to check for changed `.jsonl` session files (`syncAllSessions`) and its own set of SQLite aggregation queries (`getDashboardStats`). This can unnecessarily spike CPU and disk I/O, especially when session files grow large or the database expands.

## 📊 Impact:
- Reduces redundant disk reads during session parsing by effectively caching the in-flight synchronization promise.
- Eliminates duplicate database aggregation queries when handling concurrent frontend/API requests.
- Makes the `/api/stats` and `/api/sync` endpoints significantly more resilient under concurrent load.

## 🔬 Measurement:
1. Fire multiple concurrent requests (e.g. `ab -c 10 -n 10 http://localhost:3847/api/stats` or trigger multiple UI refreshes simultaneously).
2. Monitor database interactions and application logs. You will observe that only one instance of `initDb` and directory scanning occurs, rather than a full spike per concurrent connection.
