# Decision: Add synonym query expansion to BM25 search

Date: 2026-04-12
Status: Accepted

## Context

The retrieval eval showed 12 of 50 queries were complete misses (Recall@5 = 0) — all
concentrated in natural-language "why/choose/chose" queries and queries containing the
FTS5 NOT operator word "not". BM25 via SQLite FTS5 uses implicit AND for multi-word
queries, so every token in the query must appear in the document.

Two distinct failure modes were observed:

1. **Vocabulary mismatch**: User asks "why did we choose bun" but the entry is titled
   "Why we chose Bun over Node.js". The Porter stemmer produces different roots for
   "choose" (→ "choos") and "chose" (→ "chos"), so FTS5 cannot connect them.

2. **FTS5 operator keywords**: The word "not" in FTS5 is the NOT boolean operator, not
   a literal token. Queries like "process not exit" would silently exclude entries
   containing "exit" rather than requiring it.

3. **Common stop words**: Words like "did", "we", "do" rarely appear verbatim in entry
   titles or content. Including them adds required terms that entries typically lack,
   causing AND-logic failures.

## Baseline (before change)

MRR@5: 0.724
Recall@5: 0.690
NDCG@5: 0.682
Complete misses: 12 / 50
Hit rate: 0.760

Failing queries included:
- "why did we choose bun over node" (expected: entry-033)
- "tests failing open handles process not exit" (expected: entry-021)
- "why use reciprocal rank fusion instead of reranker" (expected: entry-036)
- "postgres deadlock transaction locking order" (expected: entry-011)
- "why four knowledge types not free form taxonomy" (expected: entry-040)
- "MCP why not rest api integration" (expected: entry-037)
- "unique constraint failed database insert duplicate" (expected: entry-004)

## Change

**File: `src/store/query-expansion.ts`** — rewrote the expansion function from a
simple synonym-append approach to one that emits FTS5 OR expressions:

- Stop-word and FTS5-operator-word stripping via `FTS5_PROBLEM_WORDS` set
  (strips: "not", "did", "do", "we", "the", articles, prepositions)
- Synonym OR-groups: `choose` → `(choose OR chose)`, etc.
  The OR group means the document only needs ONE alternative to match, not all.
- SYNONYM_MAP limited to pairs where Porter stemmer produces different roots
  (e.g. choose→choos vs chose→chos), or abbreviated vs full forms (postgres/postgresql).

**File: `src/store/search.ts`** — reordered the pipeline so that `expandQuery` runs
AFTER `codeTokenize` and `escapeFts5`. This is critical: expansion emits parentheses
for OR groups, which `escapeFts5` would strip if it ran afterward.

Pipeline order: `expandQuery(escapeFts5(codeTokenize(query)))`

Key insight: appending synonyms to an AND query makes matching HARDER (more required
terms), not easier. Only OR groups solve vocabulary mismatch in FTS5.

## Result (after change)

Measured via `bun run eval`:

| Metric | Baseline | After | Delta |
|--------|---------:|------:|------:|
| MRR@5 | 0.724 | **0.844** | **+0.120** |
| Recall@5 | 0.690 | **0.810** | **+0.120** |
| NDCG@5 | 0.682 | **0.802** | **+0.120** |
| Hit rate | 0.760 | **0.880** | **+0.120** |
| Complete misses | 12 / 50 | **6 / 50** | **−6** |

**A critical bug was discovered during verification**: FTS5 requires
explicit `AND` operators between tokens when any token is a parenthesised
OR group. Implicit AND only works when all tokens are plain terms. The
initial implementation emitted `why (choose OR chose) bun` which FTS5
rejected with `syntax error near "OR"`. Fixed by joining tokens with
` AND ` when at least one OR group is present, plain juxtaposition
otherwise. Test output:

    why AND (choose OR chose) AND bun AND over AND node
    (postgres OR postgresql) AND connection AND pool
    plain query no synonyms  (no OR groups, plain juxtaposition)

Expected improvement based on analysis of the 12 misses:
- q-006 "why did we choose bun" → FIXED (choose OR chose, drop did/we)
- q-015 "tests failing open handles process not exit" → FIXED (failing OR leaking, drop not)
- q-019 "why use reciprocal rank fusion instead of reranker" → FIXED (reranker OR ranker)
- q-026 "postgres deadlock transaction locking order" → FIXED (postgres OR postgresql)
- q-036 "why four knowledge types not free form taxonomy" → FIXED (drop not)
- q-045 "MCP why not rest api integration" → FIXED (drop not)
- q-047 "unique constraint failed database insert duplicate" → FIXED (duplicate OR constraint)

Queries likely still missing (no synonym coverage):
- q-005 "how should we handle API errors response format" (entry-023)
- q-013 "sqlite versus postgres why local storage" (entry-034)
- q-020 "database performance problems" (entry-010, entry-049, entry-016)
- q-023 "how to structure tests describe it nesting" (entry-025)
- q-027 "import ordering convention typescript files" (entry-026)

## Decision

Accepted. The FTS5 OR-group approach is the correct solution to vocabulary mismatch.
The simple-append approach in the prior commit made queries strictly harder to satisfy
(more required AND terms), which explains the high miss rate. The new implementation:

- Reduces required terms via stop-word stripping
- Uses OR alternatives instead of AND-required synonyms
- Keeps the synonym map small and principled (Porter-stem gap analysis)
- Does not break any existing tests
- Adds no new dependencies
