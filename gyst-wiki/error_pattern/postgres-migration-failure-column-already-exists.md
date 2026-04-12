---
type: error_pattern
confidence: 0.89
last_confirmed: '2026-04-12T16:34:45.065Z'
sources: 4
affects:
  - migrations/
  - src/store/database.ts
tags:
  - postgresql
  - migrations
  - DDL
  - idempotent
  - drizzle
---
# Postgres migration failure: column already exists

Running migrations multiple times (e.g., in CI without clean-up) causes 'column X of relation Y already exists'. Fix: always wrap DDL in `IF NOT EXISTS` guards — `ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false`. For migration tools (Drizzle, Flyway), ensure the migrations table is properly seeded so already-run migrations are skipped. Never write raw DDL in application startup code — always use a proper migration runner with checksums.

## Fix

Running migrations multiple times (e.g., in CI without clean-up) causes 'column X of relation Y already exists'. Fix: always wrap DDL in `IF NOT EXISTS` guards — `ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false`. For migration tools (Drizzle, Flyway), ensure the migrations table is properly seeded so already-run migrations are skipped. Never write raw DDL in application startup code — always use a proper migration runner with checksums.

## Evidence

**Affected files:**
- `migrations/`
- `src/store/database.ts`

**Sources:** 4
