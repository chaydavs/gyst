---
type: convention
confidence: 0.97
last_confirmed: '2026-04-12T16:34:45.073Z'
sources: 9
affects:
  - src/store/database.ts
  - src/store/search.ts
tags:
  - sql
  - security
  - parameterized-queries
  - injection
  - convention
---
# Database access: always use parameterized queries, never string interpolation

All database queries must use parameterized bindings — never interpolate variables into SQL strings. Correct: `db.query('SELECT * FROM entries WHERE id = ?').get(id)`. Wrong: `db.query('SELECT * FROM entries WHERE id = ' + id)`. This applies equally to FTS5 MATCH clauses and dynamic IN lists (build the placeholders string, bind the values array). Code review must reject any SQL with string concatenation. ESLint rule `no-restricted-syntax` can flag template literal SQL.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `src/store/search.ts`

**Sources:** 9
