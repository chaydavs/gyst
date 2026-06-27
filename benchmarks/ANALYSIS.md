# ANALYSIS.md — Phase 4 (learn from the frozen baseline)

**Baseline run:** `gyst-baseline` (LongMemEval-S, 500 questions). Judge + answerer **sonnet-4.5**. Vector OFF (sqlite-vec not installed). Dataset sha256 `d6f21ea9…c3a442`.
**Tool:** `src/analysis/analyze-run.ts` (deterministic classification from each evaluation's `searchResults`).

---

## 1. Headline (the only number that travels: end-to-end answer accuracy)

| Metric | Value |
|---|---|
| **Accuracy** | **13.8% (69/500)** |
| Avg context tokens / q | 280 |
| Mean search latency | 26 ms |
| Mean answer latency | 5,220 ms |

> Reminder (guardrail #1): this is **answer accuracy** under a sonnet-4.5 judge. It is NOT a retrieval metric and must never be reported as one. Because the judge is sonnet-4.5 (not gpt-4o, due to key availability), this sits beside supermemory's **sonnet-4-class** numbers, not their gpt-4o headline. The gpt-4o-matched run is a documented TODO.

## 2. Category ranking (worst → best)

| Rank | Category | Correct/Total | Accuracy |
|---|---|---|---|
| 1 (worst) | single-session-assistant | 1/56 | **1.8%** |
| 2 | temporal-reasoning | 8/133 | **6.0%** |
| 3 | multi-session | 9/133 | 6.8% |
| 4 | knowledge-update | 14/78 | 17.9% |
| 5 | single-session-user | 21/70 | 30.0% |
| 6 (best) | single-session-preference | 16/30 | 53.3% |

The gradient is exactly what the mechanism analysis predicts: single-session **preference/user** (one chunk, salient keywords) survive; everything requiring **cross-session** gathering, **temporal** reasoning, or **oblique reference** to a past assistant turn collapses.

## 3. Retrieval-miss vs answer-miss split (decides where the fix lives)

A failure is a **retrieval-miss** if `searchResults` was empty (the answer model got nothing), an **answer-miss** if context was returned but the answer was still wrong.

| Scope | Retrieval-miss | Answer-miss |
|---|---|---|
| **Overall (431 incorrect)** | **414 (96.1%)** | 17 (3.9%) |
| single-session-assistant (55) | 55 (100%) | 0 |
| temporal-reasoning (125) | 123 (98.4%) | 2 |

**Conclusion: the loss is almost entirely retrieval.** 96% of failures never showed the answer model any context. Only 3.9% of failures are "context was there, model blew it" — and those are out of Gyst's control (answer-stage). **Fixing Gyst's retrieval is both necessary and nearly sufficient.**

## 4. Retrieval ceiling (upper bound — what's even worth chasing)

If every retrieval-miss were converted to a correct answer:

| Scenario | Ceiling |
|---|---|
| baseline | 13.8% |
| 50% of retrieval-misses recovered | **55.2%** |
| 100% of retrieval-misses recovered | **96.6%** |

The retrieval ceiling is **96.6%** — i.e., retrieval, not the answer model, is the entire game here. Even recovering *half* the empty retrievals roughly **quadruples** accuracy. This is an optimistic upper bound (a recovered retrieval doesn't guarantee a correct answer), but it sizes the prize and justifies spending all Phase-5 effort on retrieval.

## 5. Why retrieval returns empty — ranked, mechanism-grounded hypotheses

(From the parallel mechanism investigation; each tied to a real Gyst code path. Full evidence in WORKLOG / agent reports.)

| # | Hypothesis | Mechanism & evidence | Targets | Expected leverage |
|---|---|---|---|---|
| **H1** | **Enable embeddings** (install sqlite-vec, backfill, GYST_SQLITE_PATH) | Vector OFF: `entry_vectors` virtual table never created without sqlite-vec (`embeddings.ts:142`), so `searchByVector→[]`. Gyst's own `decisions/006` measured enabling it: complete-misses **6/50→0/50**, Recall@5 0.81→0.98. | the whole empty-retrieval class (vocabulary mismatch) | **Highest.** Semantic match recovers "vintage cameras" ↔ "old film cameras" where BM25-AND fails. |
| **H2** | **OR-mode BM25 fallback** when AND yields 0 | `expandQuery` joins terms with spaces → FTS5 **implicit-AND** (`query-expansion.ts:138`). "What is the name of my dog?" → `what AND name AND my AND dog` → 0. No OR fallback exists. ~30 LOC. | natural-language questions where some terms are absent | High, low-risk; complements H1 if embeddings can't be installed. |
| **H3** | **Strip question-words + pronouns** before MATCH | `FTS5_PROBLEM_WORDS` removes "is/the/of" but keeps "what/which/my" (`query-expansion.ts:30`), inflating the AND burden. ~10 LOC. | reduces AND-miss rate broadly | Medium-high, ~10 LOC, low risk. |
| **H4** | **Conversational entity extraction** (noun-phrase / proper-noun) | `extractEntities` is camelCase/`function`/`def`-only (`entities.ts`); conversational text → **0 entity tags → 0 graph edges** → `searchByGraph` dead (multi-session 0%). | multi-session, cross-session linking | Medium; larger change, enables graph + auto-linking. |
| **H5** | **Broaden temporal trigger** to comparative/ordinal phrasing | `parseTimeReference` needs explicit "yesterday/last week" (`temporal.ts:62`); "which did I start **first**" → `null` → `[]`. Temporal is a re-ranker, can't rescue empty BM25. | temporal-reasoning | Medium for one category; risk of over-trigger. |

**Ruled out:** the **0.15 confidence floor** is NOT a cause — new entries are seeded at 0.5 (`ingest`/`learn` confidence=0.5), comfortably above the floor. Empty results are genuine "nothing matched", not over-filtering.

## 6. Phase-5 plan (one change at a time, measure each against the frozen 13.8%)

Sequencing matters because H1 and H2 attack the **same** failure class — running both at once would make the delta unattributable.

1. **H2 first** (OR-mode BM25 fallback) — cheapest, pure-local, no system deps; isolates "how much does relaxing AND alone buy?"
2. **H3** (stopword expansion) — stack on H2, tiny.
3. **H1** (enable embeddings) — the big lever; measure on top, and *also* in isolation vs baseline to attribute cleanly.
4. **H4 / H5** — category-targeted, only if budget remains; watch for cross-category regressions (always read the whole profile).

**Overfitting guard (committed now):** hold out a random slice of question-ids that I will NOT inspect failures on; after the final change, run it once. If the gain doesn't replicate there, we overfit. (Implementation: the harness supports `-l`/sampling; I'll reserve a fixed id set.)

**Note on the 3.9% answer-misses:** 17 questions where context was returned but the answer was wrong — these are answer-stage, outside Gyst's retrieval. Not a Phase-5 target; reported for honesty.

---

## Exit gate 4 checklist
- [x] All six categories broken out and ranked worst→best (§2)
- [x] Weakest-two categories: retrieval-vs-answer split (§3)
- [x] Ranked hypotheses, each tied to a real Gyst mechanism (§5)
- [x] Retrieval ceiling estimate (§4)

**STOP — awaiting your review before Phase 5 (Iterate).**
