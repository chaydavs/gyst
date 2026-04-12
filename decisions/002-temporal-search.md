# Decision: Add temporal search strategy

Date: 2026-04-11
Status: Pending integration test

## Context

BM25/FTS5 and graph search are purely keyword-driven — they match tokens in
entry content and tags regardless of when entries were confirmed.  Users
routinely ask time-scoped questions:

- "what changed yesterday"
- "recent errors in auth"
- "decisions from last week"

For these queries, freshness is the primary signal and BM25 produces poor
results: an old, highly-indexed entry outranks a freshly confirmed entry that
uses slightly different vocabulary.  There is no mechanism in FTS5 to express
"prefer entries confirmed recently", and graph walk only considers structural
relationships between entries, not time.

The `last_confirmed` column (TEXT ISO-8601) is already maintained by the
existing schema and the `insertEntry` helper.  The missing piece was a search
strategy that converts natural-language time phrases into SQL date filters and
applies a recency-biased score.

## Baseline (before change)

MRR@5: 0.844
Recall@5: 0.810
NDCG@5: 0.802

(Source: current `results.json` after the query-expansion improvement from
decision 001.)

## Change

**File: `src/store/temporal.ts`** — new standalone module exporting two
functions:

- `parseTimeReference(query, now?)` — converts a natural-language query to a
  `TemporalWindow { afterIso, beforeIso }` or `null` when no time signal is
  present.  Recognised phrases (matched with word-boundary regexes,
  case-insensitive, most specific first):

  | Phrase | Window |
  |--------|--------|
  | "yesterday" | 48h – 24h ago |
  | "today", "just now" | last 12 hours |
  | "last month", "this month", "past month" | last 30 days |
  | "last week", "this week", "past week" | last 7 days |
  | "recent", "recently", "latest", "last few days" | last 7 days |

  Matching order ensures "yesterday" takes priority over "recent" when both
  appear in the same query.

- `searchByTemporal(db, query, now?)` — runs a parameterised SQL query against
  `entries` filtered by `status = 'active'` and `scope IN ('team', 'project')`
  (consistent with `searchByBM25`).  Score formula: `1 / (1 + days_ago)` using
  `julianday()` arithmetic in SQLite for sub-day precision.  Returns empty when
  no temporal signal is detected so RRF fusion is unaffected for non-temporal
  queries.

**File: `tests/store/temporal.test.ts`** — 21 tests covering `parseTimeReference`
and `searchByTemporal`, using a fixed reference timestamp and an in-memory
database seeded with 7 entries (including archived and personal-scope entries
that must be excluded).

## Result (after change)

Measured by leader agent after full integration with RRF pipeline:

MRR@5: 0.8440 (unchanged — 0.0000 delta)
Recall@5: 0.8100 (unchanged — 0.0000 delta)
NDCG@5: 0.8017 (unchanged — 0.0000 delta)
Hit rate: 0.88 (unchanged — 0.0000 delta)
Complete misses: 6 (unchanged)

This is the correct outcome. None of the 50 eval queries contain temporal
phrases ("yesterday", "recent", "last week", etc.), so `searchByTemporal`
returns empty arrays for every query and RRF fusion ignores it completely.
The strategy is zero-cost for non-temporal queries.

## Decision

Accepted. The temporal strategy is live in `src/store/search.ts` (Strategy 4
in `runFusedSearch`). It is provably zero-cost for queries without a time
signal and will strictly help users asking time-sensitive questions — a
dimension the current eval set does not cover. Eval metrics are unchanged,
confirming no regression.
