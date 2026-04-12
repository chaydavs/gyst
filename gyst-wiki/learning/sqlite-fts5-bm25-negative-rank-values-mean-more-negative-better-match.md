---
type: learning
confidence: 0.89
last_confirmed: '2026-04-12T16:34:45.082Z'
sources: 3
affects:
  - src/store/search.ts
tags:
  - sqlite
  - fts5
  - bm25
  - search
  - learning
  - gotcha
---
# SQLite FTS5 BM25: negative rank values mean more negative = better match

FTS5's bm25() function returns negative values — the more negative, the better the match. This is counterintuitive but documented. When sorting by relevance, use ORDER BY rank (ascending, not DESC), or negate the rank: -rank for a positive score where higher = better. This bit us when a sort direction bug caused worst matches to appear first. Also: BM25 rank is only meaningful for comparison within the same query — don't store raw ranks as persistent confidence scores.

## Evidence

**Affected files:**
- `src/store/search.ts`

**Sources:** 3
