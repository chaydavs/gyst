---
type: error_pattern
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.058Z'
sources: 3
affects:
  - src/store/database.ts
  - tests/store/database.test.ts
tags:
  - sqlite
  - SQLITE_BUSY
  - concurrency
  - wal
  - bun
---
# SQLITE_BUSY: database is locked

SQLite returns SQLITE_BUSY when a second writer tries to acquire the write lock while WAL checkpoint is running, or when multiple Bun workers share the same DB file without coordination. Fix: (1) ensure only one writer process at a time using a queue or single-process architecture; (2) set `PRAGMA busy_timeout = 5000` immediately after opening the connection; (3) for tests, use separate in-memory databases per worker with `new Database(':memory:')`. Never share a single Database instance across async tasks without a mutex.

## Fix

SQLite returns SQLITE_BUSY when a second writer tries to acquire the write lock while WAL checkpoint is running, or when multiple Bun workers share the same DB file without coordination. Fix: (1) ensure only one writer process at a time using a queue or single-process architecture; (2) set `PRAGMA busy_timeout = 5000` immediately after opening the connection; (3) for tests, use separate in-memory databases per worker with `new Database(':memory:')`. Never share a single Database instance across async tasks without a mutex.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `tests/store/database.test.ts`

**Sources:** 3
