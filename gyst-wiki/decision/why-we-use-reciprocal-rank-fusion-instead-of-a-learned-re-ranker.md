---
type: decision
confidence: 0.85
last_confirmed: '2026-04-12T16:34:45.078Z'
sources: 3
affects:
  - src/store/search.ts
  - docs/decisions/rrf-vs-reranker.md
tags:
  - search
  - rrf
  - ranking
  - decision
  - ml
  - architecture
---
# Why we use Reciprocal Rank Fusion instead of a learned re-ranker

Decision made 2024-Q3: RRF chosen over a learned re-ranker (cross-encoder or ColBERT) because: (1) zero latency overhead — RRF is a simple arithmetic fusion requiring no model inference; (2) no training data required — we don't have labeled relevance judgments yet; (3) RRF is well-studied (Cormack et al. 2009) and performs surprisingly well on heterogeneous result lists; (4) the k=60 default is robust and requires no tuning. Learned re-rankers would be appropriate once we have >1000 labeled query-result pairs from real usage. See tune-weights.ts for empirical weight tuning.

## Evidence

**Affected files:**
- `src/store/search.ts`
- `docs/decisions/rrf-vs-reranker.md`

**Sources:** 3
