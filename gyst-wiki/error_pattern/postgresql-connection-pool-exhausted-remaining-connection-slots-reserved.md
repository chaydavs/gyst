---
type: error_pattern
confidence: 0.91
last_confirmed: '2026-04-12T16:34:45.062Z'
sources: 4
affects:
  - src/store/database.ts
  - src/api/middleware.ts
tags:
  - postgresql
  - connection-pool
  - serverless
  - pgbouncer
  - performance
---
# PostgreSQL connection pool exhausted: remaining connection slots reserved

Production API returns 500 with 'remaining connection slots are reserved for non-replication superuser connections'. pg pool defaults to 10 connections but the app opens a new pool per Lambda/worker invocation. Fix: (1) use a connection pooler like PgBouncer in transaction-mode in front of Postgres; (2) for serverless, use `pg-pool` with `max: 2` and `idleTimeoutMillis: 1000`; (3) always call `pool.end()` or `client.release()` in finally blocks; (4) set `connection_limit` in DATABASE_URL for Prisma. Monitor with `SELECT count(*) FROM pg_stat_activity`.

## Fix

Production API returns 500 with 'remaining connection slots are reserved for non-replication superuser connections'. pg pool defaults to 10 connections but the app opens a new pool per Lambda/worker invocation. Fix: (1) use a connection pooler like PgBouncer in transaction-mode in front of Postgres; (2) for serverless, use `pg-pool` with `max: 2` and `idleTimeoutMillis: 1000`; (3) always call `pool.end()` or `client.release()` in finally blocks; (4) set `connection_limit` in DATABASE_URL for Prisma. Monitor with `SELECT count(*) FROM pg_stat_activity`.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `src/api/middleware.ts`

**Sources:** 4
