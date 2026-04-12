---
type: error_pattern
confidence: 0.81
last_confirmed: '2026-04-12T16:34:45.068Z'
sources: 2
affects:
  - tests/store/database.test.ts
  - tests/mcp/server.test.ts
tags:
  - bun
  - testing
  - open-handles
  - cleanup
  - database
---
# Bun test runner: async test leaking open handles

Bun test exits with 'process did not exit cleanly' when tests open database connections, HTTP servers, or timers without tearing them down. Symptoms: test suite hangs after all tests pass. Fix: always close resources in afterAll/afterEach: `afterAll(() => { db.close(); server.stop(); })`. For SQLite in tests, use `new Database(':memory:')` and call `db.close()` in afterAll. For timers, clear them in cleanup. Use `--timeout 5000` to detect hanging tests early.

## Fix

Bun test exits with 'process did not exit cleanly' when tests open database connections, HTTP servers, or timers without tearing them down. Symptoms: test suite hangs after all tests pass. Fix: always close resources in afterAll/afterEach: `afterAll(() => { db.close(); server.stop(); })`. For SQLite in tests, use `new Database(':memory:')` and call `db.close()` in afterAll. For timers, clear them in cleanup. Use `--timeout 5000` to detect hanging tests early.

## Evidence

**Affected files:**
- `tests/store/database.test.ts`
- `tests/mcp/server.test.ts`

**Sources:** 2
