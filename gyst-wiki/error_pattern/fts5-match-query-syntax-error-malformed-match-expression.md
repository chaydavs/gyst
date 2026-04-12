---
type: error_pattern
confidence: 0.86
last_confirmed: '2026-04-12T16:34:45.066Z'
sources: 3
affects:
  - src/store/search.ts
tags:
  - sqlite
  - fts5
  - search
  - sql-injection
  - escaping
---
# FTS5 MATCH query syntax error: malformed MATCH expression

SQLite FTS5 throws 'malformed MATCH expression' when the query contains special characters like `(`, `)`, `*`, `:`, `^`, `"`. User-supplied queries must be escaped before passing to MATCH. Fix: replace all FTS5 special characters with spaces: `query.replace(/["*():^{}]/g, ' ')`. Alternatively, use a phrase search by wrapping the whole query in quotes: `"${query.replace(/"/g, '')}"`  for exact phrase matching. Never interpolate raw user input into FTS5 MATCH clauses.

## Fix

SQLite FTS5 throws 'malformed MATCH expression' when the query contains special characters like `(`, `)`, `*`, `:`, `^`, `"`. User-supplied queries must be escaped before passing to MATCH. Fix: replace all FTS5 special characters with spaces: `query.replace(/["*():^{}]/g, ' ')`. Alternatively, use a phrase search by wrapping the whole query in quotes: `"${query.replace(/"/g, '')}"`  for exact phrase matching. Never interpolate raw user input into FTS5 MATCH clauses.

## Evidence

**Affected files:**
- `src/store/search.ts`

**Sources:** 3
