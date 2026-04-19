# Search: Strategies, Fusion, and Intent

## Overview

Every `recall` and `search` call runs five independent search strategies in parallel, fuses the results with Reciprocal Rank Fusion (RRF), then applies post-fusion boosts based on entry type, query intent, and user feedback history. All five strategies are implemented in `src/store/search.ts` and `src/store/temporal.ts`.

---

## Strategy 1: File-Path Search

**Function**: `searchByFilePath(db, files)`

Exact lookup against the `entry_files` join table. Given a list of file paths from the caller, returns all entries associated with any of those paths, scored by how many of the requested paths they match.

```sql
SELECT entry_id, COUNT(*) AS match_count
FROM entry_files
WHERE file_path IN (...)
GROUP BY entry_id
ORDER BY match_count DESC
LIMIT 200
```

Score: the match count (number of overlapping file paths). Returns empty when `files` is empty.

**Best for**: "Show me everything relevant to `src/store/search.ts`."

---

## Strategy 2: BM25 / FTS5 Full-Text Search

**Function**: `searchByBM25(db, query, type?, developerId?, includeAllPersonal?)`

Full-text search using SQLite's FTS5 virtual table with the `porter unicode61` tokenizer. BM25 ranking is built into FTS5 and returned as a negative `rank` value (more negative = better match).

### Query Pre-processing Pipeline

Three transformations are applied before the query reaches FTS5:

1. **`codeTokenize(query)`** — splits code identifiers into tokens:
   - `getUserName` becomes `get user name` (camelCase splitting)
   - `get_user_name` becomes `get user name` (snake_case)
   - `this.auth` becomes `this auth` (dot notation)
   - Lowercases everything

2. **`escapeFts5(text)`** — strips any character that is not alphanumeric, whitespace, or underscore. Hyphens are stripped because FTS5's query parser mishandles them. An allowlist approach is used rather than a blocklist to prevent whack-a-mole with FTS5's underdocumented special characters.

3. **`expandQuery(text)`** — adds synonym OR-groups for common terms. For example, `error` might expand to `error OR exception OR failure`. Expansion runs last, after escapeFts5, because it introduces parentheses that must not be stripped.

### Scope Clause

The scope clause is injected into the SQL depending on who is asking:

- Known developer_id: team, project, and the caller's personal entries
- Personal mode, no developer_id: no scope filter (single-user DB — all entries visible)
- Team mode, no developer_id: team and project only, personal entries excluded

**Score**: negated FTS5 rank (higher = better). **Returns up to 50 results**.

---

## Strategy 3: Graph Traversal

**Function**: `searchByGraph(db, query)`

Finds "seed" entries by substring matching the query against file paths and tags, then walks one hop outward through the `relationships` table to surface related entries.

**Step 1**: Find seeds — entries where any associated file path or tag contains the query string (case-insensitive LIKE match, up to 200 seeds).

**Step 2**: Walk one hop outward via `relationships`, collecting target IDs.

**Scores**: Seeds receive `2.0`; one-hop neighbours receive `1.0`. Duplicate IDs keep the highest score.

**Best for**: "Tell me about auth" — finds entries tagged `entity:authToken` as seeds, then surfaces related entries even if they don't contain the word "auth" in their text.

---

## Strategy 4: Temporal Search

**Function**: `searchByTemporal(db, query)` (implemented in `src/store/temporal.ts`)

Filters entries by `last_confirmed` when the query contains natural-language time references. Returns empty immediately when no time signal is detected, making it zero-cost for non-temporal queries.

Recognized time signals include: `recent`, `latest` (last 7 days), `yesterday` (24-48 hours ago), `last week` (7-14 days ago), `last month` (30 days ago), and `N days ago` (exact offset).

**Best for**: "What errors did we fix recently?" or "Show me last week's decisions."

**Intent weighting**: When the query intent is classified as `debugging` or `history`, temporal results are included twice in the RRF input list, effectively doubling their weight in the fusion.

---

## Strategy 5: Semantic / Vector Search

**Function**: `searchByVector(db, query, limit, developerId?)` (in `src/store/embeddings.ts`)

ANN (approximate nearest-neighbor) search using the `sqlite-vec` extension on a custom SQLite binary. Generates an embedding for the query and searches the `vec_entries` vector table.

**Availability**: Only active when `canLoadExtensions()` returns true — meaning a system SQLite binary with extension loading was found at startup (Homebrew SQLite on macOS, or system libsqlite3 on Linux). Falls back gracefully to empty results when unavailable — all four other strategies still run.

Embeddings are computed for `"${title}\n\n${content}"` at learn-time and stored in the vector table. At recall-time, the query embedding is compared by cosine distance.

---

## Reciprocal Rank Fusion

**Function**: `reciprocalRankFusion(rankedLists, k=60)`

Combines the five strategy outputs into a single ranked list using RRF (Cormack, Clarke & Buettcher, 2009).

For each document `d` across all lists:

```
RRF_score(d) = sum of 1 / (k + rank(d, list))
```

Where `rank` is 1-indexed and `k=60` is the standard smoothing constant. Documents absent from a list contribute nothing for that list. The final list is sorted by descending fused score.

---

## Post-Fusion Boosts

After RRF produces a ranked list and entries are hydrated from the database, additional boosts are applied:

| Condition | Boost |
|-----------|-------|
| `type = 'ghost_knowledge'` | +0.15 (capped at 1.0) |
| `type = 'convention'` with files in query | +0.05 |
| `status = 'consolidated'` | +0.10 |
| Intent-based per-type boosts | varies |

### Intent Classification

`classifyIntent(query)` applies three regular expressions in priority order:

- Matches debugging keywords (error, bug, fail, crash, exception, broken, fix, stack, trace, why, wrong) → `"debugging"` intent
- Matches temporal keywords (recent, last, latest, yesterday, today, history, ago, week, month) → `"temporal"` intent
- Matches quality keywords (convention, pattern, best practice, style, lint, refactor, clean, format, standard) → `"code_quality"` intent
- None match → `"conceptual"` intent

Intent-based boosts:
- `debugging` intent: boosts `error_pattern` entries
- `code_quality` intent: boosts `convention` entries
- `temporal` intent: boosts recently-confirmed entries (via double-weighted temporal results)
- `conceptual` intent: boosts `decision` and `learning` entries

---

## Tier Sorting

After all boosts are applied, the final sort has two levels:

1. **Priority tier** (lowest wins): ghost_knowledge=0, convention=1, everything else=2
2. **Score within tier**: descending by boosted score

This guarantees ghost knowledge (mandatory team constraints) always appears before conventions, which always appear before other types — regardless of BM25 score.

---

## Ghost Knowledge: Tier 0

Ghost knowledge entries receive special treatment in recall:

1. Included regardless of confidence threshold (hardcoded bypass)
2. Receive a +0.15 RRF score boost after hydration
3. Placed in tier 0, before all other entry types
4. Titles are prefixed with a warning indicator in formatted output

This ensures that hard constraints are always visible to the agent before it begins working.

---

## Co-Retrieval Recording

After every `recall` or `search` call that returns 2 or more results, all unique unordered pairs are recorded in the `co_retrievals` table with an upsert:

```sql
INSERT INTO co_retrievals(entry_a, entry_b, count, last_seen)
VALUES (?, ?, 1, ?)
ON CONFLICT(entry_a, entry_b)
DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
```

The `entry_a < entry_b` canonical ordering prevents duplicate rows. When a pair's `count` reaches 3 or more, `strengthenCoRetrievedLinks()` promotes it to an explicit `related_to` edge in the `relationships` table. This means frequently co-retrieved entries gradually become graph neighbors, strengthening traversal-based discovery over time.
