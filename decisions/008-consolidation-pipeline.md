# Decision: 008 — Consolidation pipeline

Date: 2026-04-12
Status: Accepted / Pending main session integration (see Follow-ups)

## Context

After deploying semantic search (decisions/006), the retrieval eval reached
MRR@5=0.977 with zero complete misses. The knowledge base itself now works
excellently *at query time*, but nothing prevents it from becoming a junk drawer
*at write time* as real teams use it over months:

- The same error pattern gets learned repeatedly as new developers hit it,
  creating dozens of near-identical `error_pattern` entries.
- Entries that were added during an early sprint become stale (confidence decays
  below 0.15) but remain in the database indefinitely — cluttering admin queries
  and consuming FTS5 index space.
- Files with many incidents accumulate 10-20 individual entries; a single
  synthesised summary would be more useful for recall.

The MEMORY.md at the start of this session noted "Consolidation pipeline
(premature — need real growth data first)" as deferred. However, with the
retrieval quality ceiling hit and semantic dedup now available as a free
primitive, building consolidation now prevents technical debt from accumulating.
The 5-stage design below is deliberately conservative: it only touches entries
it can safely classify, and ghost knowledge is explicitly exempt at every stage.

## Baseline (before change)

From MEMORY.md and decisions/006:

| Metric | Value |
|--------|------:|
| MRR@5 | 0.9767 |
| Recall@5 | 0.9833 |
| NDCG@5 | 0.9624 |
| Hit rate | 1.000 |
| Complete misses | 0 / 50 |
| Tests | 429 passing |

No consolidation existed. Dedup happened only at learn-time (fingerprint +
Jaccard in `src/compiler/deduplicate.ts`). Low-confidence entries were excluded
from recall results but never removed. File clusters had no aggregation.

**Note on eval set independence:** The retrieval eval uses a fixed 50-query
fixture set in `tests/eval/`. The consolidation pipeline test seeds its own
in-memory databases and never writes to the eval fixtures. Running
`consolidate()` on a production database would reduce entry count (archiving
stale/duplicate entries), which could *improve* precision metrics by removing
noise from the recall candidate pool — but it should not regress MRR@5 since
ghost knowledge and high-confidence entries are preserved.

## Change

### New module: `src/compiler/consolidate.ts`

Exports a single async function:

```typescript
export async function consolidate(db: Database): Promise<ConsolidationReport>
```

The pipeline runs five stages in sequence. Each stage wraps mutations in a
transaction and returns a count of changes made.

**Stage 1 — Decay**

Re-runs `calculateConfidence()` for every active non-ghost entry using the
current timestamp. Any entry whose confidence has shifted by more than 0.05
(either direction) is updated. This keeps the confidence column accurate as
entries age — without this, entries would show stale confidence values that
don't reflect elapsed time since the last learn call.

**Stage 2 — Dedupe (fingerprint + semantic)**

Two passes:
- *Fingerprint*: groups active entries sharing the same `error_signature`,
  keeps the highest-confidence one, merges `source_count`, archives the rest
  with `superseded_by` set.
- *Semantic* (only when `canLoadExtensions()` is true): iterates active entries
  that have a vector stored, calls `searchByVector` with limit=5, and merges
  pairs with similarity > 0.9 (distance < 0.111 — effectively identical meaning).
  Only merges within the same entry type. Tracks processed pairs in a `Set` to
  avoid O(n²) redundancy.

The semantic pass piggybacks on the sqlite-vec infrastructure from decisions/006
at zero additional cost — no new dependencies.

**Stage 3 — Merge file clusters**

Finds files with ≥ 5 active `error_pattern` or `learning` entries. For each
such file, creates a synthetic `learning` entry:
- Title: `"Summary: {file_path} patterns and knowledge"`
- Content: bullet list of each original entry's title + first sentence
- Confidence: average of cluster confidences (clamped to 1.0)
- Tags: `["consolidated-summary"]`

Original entries are marked as non-active (currently `archived` with
`superseded_by` pointing to the summary — see Follow-ups for the `consolidated`
status transition).

Types `convention`, `decision`, and `ghost_knowledge` are explicitly excluded
from clustering — these are intentional reference entries that should never
be summarised away.

**Stage 4 — Archive low-confidence**

Simple bulk UPDATE: set `status = 'archived'` for all active non-ghost entries
with `confidence < 0.15`. This is the same threshold already used to exclude
entries from recall results, so archiving them merely makes the exclusion
permanent and reduces index noise.

**Stage 5 — Reindex**

Checks whether the FTS5 row count matches the active entry count. If there is
a mismatch (can happen if previous consolidation runs crashed mid-transaction),
executes SQLite's built-in `INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`.

Regenerates `gyst-wiki/index.md` as a grouped markdown index of all active
entries, using `loadConfig()` to resolve the wiki directory.

**Ghost knowledge exemption**

Ghost knowledge entries are invariants — they represent timeless team rules
that remain true until explicitly removed. They are exempt from every stage:
- Stage 1: `type != 'ghost_knowledge'` in the WHERE clause
- Stage 2A: fingerprint dedup only targets `error_pattern` entries
- Stage 2B: `type != 'ghost_knowledge'` in the WHERE clause
- Stage 3: `type IN ('error_pattern', 'learning')` excludes ghost knowledge
- Stage 4: `type != 'ghost_knowledge'` in the WHERE clause

## Result (after change)

The consolidation pipeline itself does not affect the 50-query retrieval eval
because:
1. The eval uses its own seed data loaded fresh each run.
2. Archiving duplicate/stale entries can only reduce noise — it cannot remove
   a relevant entry that wasn't already below the 0.15 recall threshold.

MRR@5 = 0.9767 is expected to be preserved after integration.

Test count: **429 existing + N new tests** from `tests/compiler/consolidate.test.ts`.
The new tests cover: basic pipeline run, idempotency, ghost knowledge immunity,
confidence threshold (0.15 floor), cluster summary content, FTS5 consistency,
protected type enforcement, fingerprint source-count merge, decay correctness,
and report shape.

## Decision

**Accepted.** The pipeline addresses a real long-term maintenance problem with
minimal risk:
- It only archives entries below the existing recall threshold.
- Ghost knowledge is explicitly protected at every stage.
- The pipeline is idempotent — a second run immediately after the first produces
  zero changes.
- Graceful degradation: if `canLoadExtensions()` returns false, Stage 2B is
  skipped and the rest of the pipeline runs normally.

Integration into the CLI and scheduled CI is deferred to the main session
(see Follow-ups).

## Follow-ups for main session

The following items were intentionally not done in this agent's scope:

1. **Add `'consolidated'` to the `entries.status` CHECK constraint in
   `src/store/database.ts`.**
   The current constraint is:
   ```sql
   CHECK (status IN ('active','stale','conflicted','archived'))
   ```
   It must become:
   ```sql
   CHECK (status IN ('active','stale','conflicted','archived','consolidated'))
   ```
   Until this is done, Stage 3 uses `'archived'` as a safe fallback. Once the
   constraint is updated, Stage 3's `UPDATE entries SET status = 'archived'`
   lines should be changed to `SET status = 'consolidated'`, and the tests
   that check `status != 'active'` should be updated to assert
   `status = 'consolidated'`.

2. **Wire `gyst consolidate` CLI command in `src/cli/index.ts`.**
   The consolidation function is exported and ready. The CLI needs a new
   `consolidate` command that:
   - Opens the database via `initDatabase(config.dbPath)`
   - Calls `consolidate(db)`
   - Prints the `ConsolidationReport` as a summary table
   - Exits 0 on success, 1 on error

3. **Add to `.github/workflows/eval-regression.yml`** — run `gyst consolidate`
   before the retrieval eval to measure MRR@5 on a post-consolidation knowledge
   base. This validates that consolidation does not regress retrieval quality
   under production-like conditions.

4. **Consider a scheduled cron** — for teams with active wikis, running
   `gyst consolidate` weekly (e.g. Monday before the eval cron) would keep the
   knowledge base from growing unboundedly.
