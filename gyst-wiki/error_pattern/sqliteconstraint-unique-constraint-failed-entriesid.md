---
type: error_pattern
confidence: 0.82
last_confirmed: '2026-04-12T16:34:45.058Z'
sources: 2
affects:
  - src/store/database.ts
  - src/mcp/server.ts
tags:
  - sqlite
  - SQLITE_CONSTRAINT
  - unique-key
  - upsert
---
# SQLITE_CONSTRAINT: UNIQUE constraint failed: entries.id

Triggered when inserting an entry with an ID that already exists. In the MCP server this typically means the learn tool was called twice for the same session without deduplication. Fix: use INSERT OR REPLACE or INSERT OR IGNORE depending on intent. For the entries table, prefer INSERT OR REPLACE to upsert. Always generate IDs with crypto.randomUUID() rather than deterministic strings to avoid collisions. If deduplication by fingerprint is desired, check for existing fingerprint before insert.

## Fix

Triggered when inserting an entry with an ID that already exists. In the MCP server this typically means the learn tool was called twice for the same session without deduplication. Fix: use INSERT OR REPLACE or INSERT OR IGNORE depending on intent. For the entries table, prefer INSERT OR REPLACE to upsert. Always generate IDs with crypto.randomUUID() rather than deterministic strings to avoid collisions. If deduplication by fingerprint is desired, check for existing fingerprint before insert.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `src/mcp/server.ts`

**Sources:** 2
