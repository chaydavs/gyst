# 014 — Graphify as primary substrate: V2 architectural pivot

**Status:** In progress. Fix 7 and Fix 6 shipped. Observation phase pending.
**Date:** 2026-04-16

## Context

Gyst V1 uses free-floating knowledge entries with their own relationship
table. The structural code graph (from Graphify) is a sidecar — imported
into separate `structural_nodes`/`structural_edges` tables, used only for
Stage 2 classifier reranking. This creates three hard problems:

1. **Retrieval ranking needs 5-strategy RRF fusion.** File path lookup,
   BM25 via FTS5, graph traversal, temporal recency, and vector semantic
   search all run in parallel and merge through Reciprocal Rank Fusion
   (k=60). Tuning weights across five strategies is expensive, fragile,
   and opaque when results surprise users.
2. **Staleness requires type-specific time-decay formulas.** Each entry
   type has its own half-life (error_pattern: 30d, learning: 60d,
   decision: 365d, convention: no decay). Decay is correct in theory but
   disconnected from reality — an entry about a function that was deleted
   last week still looks fresh if its half-life hasn't elapsed.
3. **Deduplication needs fingerprint+Jaccard matching.** The consolidation
   pipeline runs fingerprint hashing and Jaccard similarity to find
   duplicates. This works for textually-similar entries but misses
   semantic duplicates about the same code node phrased differently.

Competitor research (ByteRover, Packmind, Qodo, Sourcegraph Cody) showed
that none of them solve the "free-floating entries" problem well either.
ByteRover uses hierarchy (Domain > Topic > Subtopic), Packmind uses
human-authored playbooks, Cody has no memory at all. The opportunity is
to anchor knowledge to code structure.

## Options considered

1. **Keep current architecture** — entries as first-class, graph as
   sidecar. Lowest risk, but the three hard problems remain and compound
   as the KB grows. Every new search strategy or entry type adds another
   tuning surface.
2. **Hybrid — bidirectional links between entries and code nodes.**
   Incremental migration: add a `node_id` FK to entries, build indexes
   on the join, keep both tables authoritative. Risk: two sources of
   truth for "where does this knowledge live?" and the hybrid state can
   persist indefinitely with no forcing function to complete.
3. **Full flip — code graph becomes primary, entries become annotations
   on nodes.** The structural graph from Graphify AST parsing is the
   skeleton. Knowledge attaches to nodes as annotations. Unattached
   knowledge (team-wide decisions, cultural rules, onboarding) lives as
   "root annotations" — an explicit escape hatch for the ~10% of entries
   that have no natural code anchor.

## Decision

Adopted **Option 3**: full flip with "root annotations" escape hatch.

Seven fixes in sequence, ordered by dependency and risk:

- **Fix 7 (DONE):** Delete style fingerprinting (-1,536 lines). Removes
  dead complexity that would conflict with the new type model.
- **Fix 6 (DONE):** Review queue UI on current backend. Ships user-facing
  value immediately and generates signal that drives the refactor.
- **Observe 4 weeks with design partners.** Collect confirmation/rejection
  patterns from the review queue before committing to schema changes.
- **Fix 1:** Graphify as primary substrate. Migrate entries to annotations
  on structural nodes. See schema sketch below.
- **Fix 5:** Two-axis type model (Attachment x Permanence) with promotion
  rule: observational + 3 confirms -> durable.
- **Fix 3:** Git-based staleness replaces time-decay. An annotation on a
  node whose file was modified in the last N commits is fresh; one whose
  file hasn't been touched in 90 days is stale. No more half-life math.
- **Fix 2:** Collapse search to graph-walk + semantic, BM25 as circuit
  breaker. If semantic returns < 3 results above 0.5 similarity, append
  BM25. No silent co-equal strategy — BM25 has an explicit trigger
  condition.
- **Fix 4:** Collapse tools from 14 to 6: `annotate`, `recall`, `query`,
  `feed`, `flag`, `status`.

### Key design details

- **Confirmation** = 3 distinct capture events referencing the same
  normalized signature. This is the promotion threshold from
  observational to durable.
- **Demotion** = a durable annotation that receives a contradicting
  annotation reverts to observational for re-confirmation.
- **BM25 fallback** has an explicit trigger condition (< 3 semantic
  results above 0.5), not a silent co-equal strategy. This replaces
  the 5-strategy RRF fusion.
- **Root annotations** for unattached knowledge: team-wide decisions,
  cultural rules, onboarding materials. These have `node_id = NULL`
  and `attachment = 'team_root'`.
- **Fix 6 ships BEFORE Fix 1** because user signal from the review
  queue drives which annotations matter, reducing wasted migration work.

### New schema sketch (for Fix 1)

```sql
-- Primary: code graph nodes (from Graphify AST)
-- structural_nodes and structural_edges tables remain as-is

-- Knowledge becomes annotations on nodes
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  node_id TEXT,                -- FK to structural_nodes.id (NULL for root annotations)
  content TEXT NOT NULL,
  attachment TEXT NOT NULL,    -- 'code_node' | 'team_root' | 'event'
  permanence TEXT NOT NULL,    -- 'durable' | 'observational'
  confidence REAL DEFAULT 0.5,
  confirm_count INTEGER DEFAULT 0,
  fingerprint TEXT,
  created_at TEXT,
  last_confirmed TEXT,
  FOREIGN KEY (node_id) REFERENCES structural_nodes(id)
);

-- Promotion rule: observational + confirm_count >= 3 -> durable
-- Demotion: durable + contradicting annotation -> observational
```

## Outcome

Pending. Fix 7 (style fingerprint deletion) and Fix 6 (review queue UI)
have shipped. The observation phase begins when the review queue is
published to design partners. Fixes 1-5 are gated on signal collected
during that observation window.

## Reversal criteria

Revert to Option 1 (entries-first, graph-sidecar) if:

- Design partner observation shows < 60% of useful entries have a natural
  code-node anchor, making root annotations the majority rather than the
  escape hatch.
- Graph-walk + semantic search (Fix 2) produces worse recall than the
  current 5-strategy RRF at CodeMemBench NDCG@10 (current baseline:
  0.3269). A > 15% regression is the threshold.
- The annotation migration (Fix 1) cannot preserve entry-level metadata
  that the review queue depends on, forcing a rewrite of Fix 6.
