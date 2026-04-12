---
type: error_pattern
confidence: 0.86
last_confirmed: '2026-04-12T16:34:45.063Z'
sources: 3
affects:
  - src/store/jobs.ts
  - src/api/batch.ts
tags:
  - postgresql
  - deadlock
  - transactions
  - locking
  - concurrency
---
# PostgreSQL deadlock detected: process waits for ShareLock

Deadlock between two transactions updating the same rows in different order. Error: 'deadlock detected: process X waits for ShareLock on transaction Y'. Fix: always acquire row locks in a consistent order — sort by primary key before batch updates. Use SELECT ... FOR UPDATE SKIP LOCKED for job queues. Set `lock_timeout = '5s'` to fail fast rather than hang indefinitely. Retry with exponential backoff on deadlock (error code 40P01). In Drizzle/Prisma, wrap in a retry loop.

## Fix

Deadlock between two transactions updating the same rows in different order. Error: 'deadlock detected: process X waits for ShareLock on transaction Y'. Fix: always acquire row locks in a consistent order — sort by primary key before batch updates. Use SELECT ... FOR UPDATE SKIP LOCKED for job queues. Set `lock_timeout = '5s'` to fail fast rather than hang indefinitely. Retry with exponential backoff on deadlock (error code 40P01). In Drizzle/Prisma, wrap in a retry loop.

## Evidence

**Affected files:**
- `src/store/jobs.ts`
- `src/api/batch.ts`

**Sources:** 3
