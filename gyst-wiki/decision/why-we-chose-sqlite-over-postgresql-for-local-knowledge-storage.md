---
type: decision
confidence: 0.92
last_confirmed: '2026-04-12T16:34:45.076Z'
sources: 6
affects:
  - src/store/database.ts
  - docs/decisions/sqlite-vs-postgres.md
tags:
  - sqlite
  - postgresql
  - database
  - decision
  - local-first
  - architecture
---
# Why we chose SQLite over PostgreSQL for local knowledge storage

Decision made 2024-Q1: SQLite chosen over Postgres for the local gyst-wiki store because: (1) zero-infrastructure requirement — developers should not need to run a database server to use Gyst; (2) single-file portability makes backup and sync trivial (just copy .wiki.db); (3) bun:sqlite provides WAL mode and FTS5 with no additional dependencies; (4) write throughput is more than adequate for the expected volume (hundreds of inserts per day, not millions). Postgres would be appropriate if Gyst ever needs multi-user concurrent writes or cloud sync. Current decision is intentional and load-tested up to 500k entries.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `docs/decisions/sqlite-vs-postgres.md`

**Sources:** 6
