---
type: learning
confidence: 0.81
last_confirmed: '2026-04-12T16:34:45.087Z'
sources: 2
affects:
  - src/store/search.ts
tags:
  - fts5
  - stemmer
  - search
  - recall
  - learning
  - porter
---
# Porter stemmer reduces recall for technical terms: 'typing' matches 'type' unexpectedly

FTS5's Porter stemmer stems 'typing' to 'type', 'types' to 'type', and 'typed' to 'type' — which is correct for English prose but causes unexpected cross-matching in technical contexts. 'getUserTyping' searching with 'type' returns results about TypeScript types. Mitigation: (1) use phrase searches for multi-word technical terms; (2) store error signatures in a separate non-stemmed column (which we do — see entries_fts schema); (3) weight the title and error_signature columns higher than content in BM25 scoring. This is a known limitation of BM25 vs. vector search for code.

## Evidence

**Affected files:**
- `src/store/search.ts`

**Sources:** 2
