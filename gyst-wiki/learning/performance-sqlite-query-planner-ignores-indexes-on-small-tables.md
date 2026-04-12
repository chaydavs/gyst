---
type: learning
confidence: 0.83
last_confirmed: '2026-04-12T16:34:45.086Z'
sources: 2
affects:
  - src/store/database.ts
  - tests/eval/retrieval-eval.ts
tags:
  - sqlite
  - performance
  - indexes
  - query-planner
  - learning
---
# Performance: SQLite query planner ignores indexes on small tables

SQLite's query planner does a full table scan instead of using an index when the table has fewer than ~1000 rows — it correctly determines a scan is cheaper. This confused us during development when EXPLAIN QUERY PLAN showed 'SCAN entries' even with an index. Fix: (1) stop worrying about index usage on small tables; (2) run ANALYZE after bulk inserts to update statistics for larger tables; (3) for production-scale testing, seed with representative data volumes. Our FTS5 index starts paying off around 10k entries — below that, the overhead is minimal.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `tests/eval/retrieval-eval.ts`

**Sources:** 2
