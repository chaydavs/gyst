---
type: learning
confidence: 0.9
last_confirmed: '2026-04-12T16:34:45.087Z'
sources: 4
affects:
  - tests/store/database.test.ts
  - tests/store/search.test.ts
tags:
  - testing
  - isolation
  - sqlite
  - in-memory
  - learning
  - bun
---
# Test isolation: each Bun test file should use a separate in-memory SQLite database

Running multiple test files with a shared database path causes flaky tests due to state leakage between test runs. Even with beforeEach cleanup, concurrent test files that run in parallel will interfere. Fix: each test file should call `new Database(':memory:')` and run `initDatabase()` on it — this creates a fresh isolated database per test file. Pass the database instance as a parameter (dependency injection) rather than importing a global singleton. This also makes tests run faster since they avoid disk I/O.

## Evidence

**Affected files:**
- `tests/store/database.test.ts`
- `tests/store/search.test.ts`

**Sources:** 4
