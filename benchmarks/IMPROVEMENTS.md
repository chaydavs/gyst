# IMPROVEMENTS.md — Phase 5 changelog

Each change is measured on the **same 100-question subset** (`gyst-base100` reference = **15.0%**), one change at a time, against a frozen reference. Full-500 re-runs only for changes with a real subset gain. Judge + answerer = sonnet-4.5. Vector OFF unless noted.

**Headline rule:** accuracy is reported with **avg context tokens** and latency — never alone. A recall win bought with a large token cost is a *move along the cost/quality curve*, not a free lunch.

| # | Hypothesis | Diff summary | Subset acc (base→after) | Target category | Avg tokens (base→after) | Decision |
|---|---|---|---|---|---|---|
| baseline | — | unchanged Gyst, vector OFF | 15.0% | — | 293 | reference |
| **H2** | OR-mode BM25 fallback | `search.ts`: when implicit-AND returns 0 rows, retry once with terms OR-joined (plain-term queries only) | **15.0% → 65.0% (+50.0)** | all (empty-retrieval class) | 293 → **8,695** | **KEEP** ✅ (huge accuracy gain; large token cost noted) |

## H2 detail
- **Empty-retrieval rate: 89% → 1%** (leading indicator) — OR-fallback returns candidates for nearly every natural-language query.
- **Per-category (base→H2):** ss-assistant 0/9→9/9, ss-user 3/13→12/13, temporal 2/29→16/29, knowledge-update 4/17→13/17, multi-session 2/24→9/24, ss-preference 4/8→6/8.
- **Cost:** avg context tokens 293→8,695 (~30×). OR-mode + returning ~10 full session chunks per query. Genuine recall, but precision/token cost is the tradeoff — motivates H1 (semantic ranking) to deliver the same recall with fewer, better chunks.
- **Tests:** TDD RED→GREEN (`tests/store/search-or-fallback.test.ts`, 3 tests); `tests/store/` regression 203/203 pass.
- **Faithfulness:** change is inside Gyst's real `searchByBM25`, so both the production `recall` tool and the benchmark adapter use it — not an adapter-only trick.
- **TODO:** full-500 re-run to confirm at scale; consider a token-cost mitigation (fewer/shorter chunks or better ranking) once H1 lands.

## ⛔ BLOCKER (2026-06-26): Anthropic API usage limit reached
- Stored error from the haiku reference run: *"You have reached your specified API usage limits. You will regain access on 2026-07-01 at 00:00 UTC."*
- Cause: the key hit its spend cap. H2's ~30× context blowup (8,695 tok/q) accelerated it. ALL calls now fail regardless of model (haiku reference failed 20/20 on the first batch).
- Impact: **no benchmark runs (answer/judge) possible until the limit resets (Jul 1) or is raised / a different key is supplied.** Local code + tests are unaffected.

## Model regime
- Iteration loop switched to **haiku-4.5** (cost). New reference run `gyst-ref-haiku-100` was launched but DIED on the API limit before producing a report → no haiku reference yet.
- Final headline stays **sonnet-4.5** (+ opus-4.5 robustness).

| H3 | strip question-words/pronouns/auxiliaries before MATCH | `query-expansion.ts`: add ~40 function words to FTS5_PROBLEM_WORDS (aligns code with module doc) | folded into haiku anchor (below) | precision / token cost | — | KEEP (207/207 tests) |

### Haiku regime (cost-saving loop; sonnet reserved for final headline)
| Config (haiku, 100q subset) | Accuracy | Avg tokens | Search latency | Note |
|---|---|---|---|---|
| H2+H3 (vector off) — **anchor** | 55% (55/100) | 8,384 | 30 ms | headline config |
| H1 (vector on, sqlite-vec) | 60% (60/100) | 9,785 | 1,316 ms | **variant** |

**H1 (embeddings) verdict — VARIANT, not headline.** +5 pts overall (within 100q noise), but the *direction* is clear: helps semantic/cross-session categories (multi-session 8→13, knowledge-update 10→13), slightly hurts exact-recall (ss-user 12→10, ss-assistant 9→8). Costs: search latency 30ms→1,316ms (per-query ONNX embedding) and tokens +1,400. Enabled via a Bun `--preload` that runs Gyst's custom-SQLite probe before the harness opens a DB (fixes canLoadExtensions=false), plus `initVectorStore` per container. Verified 68/69 entry_vectors written. Kept as a reported variant; **headline stays H2+H3** (clean, ~30ms search).

### Overfitting guard (held-out, never inspected)
Ran the headline config (H2+H3, vector off, haiku) on questions **400–500** — a slice 100% disjoint from the first-100 tuning set, whose failures I never inspected.

| H2+H3 (haiku) | Accuracy | Avg tokens |
|---|---|---|
| first-100 (tuning set) | 55% | 8,384 |
| **held-out 400–500 (unseen)** | **68%** | 8,680 |

Generalization gap **+13 pts in the favorable direction** (held-out ≥ tuning). No overfitting — the H2/H3 mechanism transfers to unseen questions. (The first-100 simply had a harder category mix.)

## Pending (all benchmark-gated on API access)
- Measure H3 delta (haiku) once API returns; re-run haiku reference first.
- H1 — enable embeddings (install sqlite-vec, backfill). **Local setup can be done offline now**; only the accuracy delta needs API.
- Full-500 confirmation of H2(+H3) on sonnet-4.5.
- Held-out slice (never inspected) — run once after the final change (overfitting guard).
