---
type: learning
confidence: 0.85
last_confirmed: '2026-04-12T16:34:45.083Z'
sources: 2
affects:
  - src/store/database.ts
tags:
  - sqlite
  - wal
  - bun
  - learning
  - initialization
  - performance
---
# Bun:SQLite WAL mode: enable BEFORE creating tables, not after

Setting `PRAGMA journal_mode = WAL` after tables already exist works, but only for new writes. If you create tables with the default journal mode and then switch to WAL, the database file structure is already set. Best practice: set WAL mode as the very first operation on a new database, before any schema creation. Verified: in our initDatabase function, pragmas are applied before SCHEMA_STATEMENTS. If a database was created in non-WAL mode by an old version, you need to run VACUUM to convert it properly.

## Evidence

**Affected files:**
- `src/store/database.ts`

**Sources:** 2
