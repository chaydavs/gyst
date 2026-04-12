---
type: decision
confidence: 0.84
last_confirmed: '2026-04-12T16:34:45.079Z'
sources: 3
affects:
  - src/store/search.ts
  - docs/decisions/bm25-vs-embeddings.md
tags:
  - search
  - fts5
  - bm25
  - embeddings
  - decision
  - sqlite
---
# Why we use FTS5 with Porter stemmer instead of vector embeddings for search

Decision made 2024-Q3: FTS5 BM25 chosen over vector embeddings because: (1) no inference latency or external API calls required; (2) no embedding model to host or pay for; (3) BM25 outperforms embeddings on exact-match technical queries like error signatures and function names; (4) FTS5 is available natively in SQLite with no additional dependencies. Hybrid search combining BM25 with embeddings is the ideal long-term architecture (see entry-036 on RRF). Embeddings would help for semantic queries like 'how do I handle auth errors' — track this as a future improvement once query volume is sufficient to justify the cost.

## Evidence

**Affected files:**
- `src/store/search.ts`
- `docs/decisions/bm25-vs-embeddings.md`

**Sources:** 3
