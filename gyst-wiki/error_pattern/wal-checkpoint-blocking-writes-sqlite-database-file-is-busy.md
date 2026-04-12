---
type: error_pattern
confidence: 0.84
last_confirmed: '2026-04-12T16:34:45.065Z'
sources: 2
affects:
  - src/store/database.ts
tags:
  - sqlite
  - wal
  - checkpoint
  - performance
  - disk
---
# WAL checkpoint blocking writes: SQLite database file is busy

Long-running read transactions in WAL mode prevent checkpointing, causing the WAL file to grow unbounded and eventually blocking new writers. Symptoms: DB file grows beyond 1 GB, writes become slow or fail. Fix: (1) set `PRAGMA wal_autocheckpoint = 1000` (default is 1000 pages but may be disabled); (2) never hold read transactions open during user-visible operations — use `db.query().all()` and release immediately; (3) run `PRAGMA wal_checkpoint(TRUNCATE)` during off-peak hours via a scheduled job; (4) set `busy_timeout` so writers retry instead of failing instantly.

## Fix

Long-running read transactions in WAL mode prevent checkpointing, causing the WAL file to grow unbounded and eventually blocking new writers. Symptoms: DB file grows beyond 1 GB, writes become slow or fail. Fix: (1) set `PRAGMA wal_autocheckpoint = 1000` (default is 1000 pages but may be disabled); (2) never hold read transactions open during user-visible operations — use `db.query().all()` and release immediately; (3) run `PRAGMA wal_checkpoint(TRUNCATE)` during off-peak hours via a scheduled job; (4) set `busy_timeout` so writers retry instead of failing instantly.

## Evidence

**Affected files:**
- `src/store/database.ts`

**Sources:** 2
