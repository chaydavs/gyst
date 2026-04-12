# 011 — CoIR + CodeMemBench dual benchmark

**Status**: accepted
**Date**: 2026-04-12
**Author**: Gyst team

## Context

Gyst already owns one public benchmark — LongMemEval Hit@5 = 94.2% on 500
questions (decision 010) — but LongMemEval measures *general long-term
memory*, not code-domain retrieval. For launch materials (README, a16z deck,
posts) we need credibility numbers in the domain Gyst actually targets:
knowledge about code that a team has accumulated.

No existing benchmark measures that. CoIR (ACL 2025) is the gold standard for
*code retrieval* — "find the snippet that answers this query" — but none of
the public benchmarks measure "find the error pattern, decision, convention,
or ghost rule that answers this situation," which is the job team knowledge
layers actually do.

So we ran two benchmarks in one pass:

1. **CoIR** — an existing leaderboard nobody built for us. Proves we're
   competitive at the established code-retrieval task.
2. **CodeMemBench** — a new benchmark we defined and open-sourced. Defines
   the team-knowledge-retrieval category so anyone else can compete.

## Options considered

### Option 1: CoIR only

Safe, established, comparable to other systems. Downside: measures the wrong
thing for Gyst. CoIR corpora are *source code* — Gyst is designed to retrieve
*knowledge about source code*, which is a different signal. Winning CoIR
would say "our embedding model is fine," nothing about team knowledge.

### Option 2: CodeMemBench only

Directly measures what we're building. Downside: self-built benchmark runs
into "grading your own homework" skepticism unless the methodology is
air-tight and disclosed upfront.

### Option 3 (chosen): both

CoIR as credibility anchor ("yes we can rank code"). CodeMemBench as the
category-defining move ("here's the benchmark for what we actually do — run
your system against `dataset.json` if you disagree"). Each benchmark
compensates for the other's blind spot.

## Decision

Run both. Commit both result JSONs and the CodeMemBench dataset. Disclose
the self-built nature of CodeMemBench in every launch material.

### CoIR adapter — embedding-only mode

- Python adapter in `tests/benchmark/coir/run-coir.py`
- Model: `sentence-transformers/all-MiniLM-L6-v2` — the same 384-d model
  Gyst's semantic strategy uses in production (`src/store/embeddings.ts`,
  via `@xenova/transformers`). We swap the runtime (Python vs. JS) but keep
  the identical checkpoint so the number transfers to Gyst.
- Metric implementation uses `pytrec_eval` directly rather than BEIR's
  `EvaluateRetrieval.evaluate()`. `pytrec_eval` is a thinner dependency and
  its output matches the CoIR leaderboard's scoring convention.
- 4 subtasks: `stackoverflow-qa`, `codefeedback-st`, `codefeedback-mt`,
  `cosqa`. We intentionally run a subset of CoIR's 10 tasks and **report it
  as a subset in every header**. Our mean is not directly comparable to the
  full-leaderboard mean.

### CoIR adapter — full-pipeline mode

- Python writes corpus+queries to JSON, spawns
  `bun run tests/benchmark/coir/pipeline-eval.ts` as a subprocess
- The Bun script ingests into a temp Gyst SQLite DB, backfills vectors,
  runs `runHybridSearch()` per query, emits ranked `{qid: {did: score}}` on
  stdout. Python reads it back and scores via pytrec_eval.
- Corpora > 10k are capped at 10k docs (keeping every qrels-referenced doc +
  uniform random sample of the rest) to keep the pipeline mode under 1 hour.
- This mode exercises BM25 + file-path + graph + temporal + semantic fused
  through RRF — the *full* Gyst retrieval pipeline, not just embeddings.
- Flagged as slow (20–40 min wall-clock) and not wired into CI.

### CodeMemBench — fairness-first methodology

- **Ground truth is set by construction**, not graded after the fact.
  Entries are synthesized first from realistic templates; queries are
  generated *from* entries by pulling 2–4 content words from 1–3 target
  entries and paraphrasing. `relevantEntryIds` is written at generation time.
- 500 entries + 200 queries across 8 categories × 3 difficulties
- Deterministic mulberry32 PRNG, seed=42 — dataset regenerates byte-identical
- Committed `tests/benchmark/codememb/dataset.json` as the canonical version
- README includes fairness statement + citation so anyone can run their
  system against the exact same dataset

### Strategy ablation

- `tests/benchmark/codememb/ablation.ts` runs 6 configurations (baseline +
  each of the 5 strategies disabled)
- Uses the new `disableStrategies` option on `runHybridSearch` from
  `src/store/hybrid.ts`

## Shared helper

Factored the hybrid retrieval composition out of
`tests/eval/retrieval-eval.ts` into `src/store/hybrid.ts` so both benchmark
harnesses import the exact same code path. The production `recall.ts` tool
was *not* refactored in this PR — that's a later cleanup. Scope discipline:
the benchmark must not touch production code paths beyond the factored
helper.

## Outcome

### CodeMemBench (200 queries, 500 entries, semantic enabled)

| Metric | Value |
|---|---|
| NDCG@10 | **0.3511** |
| Recall@10 | **0.6767** |
| MRR@10 | **0.2743** |
| Hit Rate | **78.0%** |

Per category NDCG@10: error_resolution 0.257, convention_lookup 0.390,
decision_rationale 0.354, ghost_knowledge 0.352, file_specific 0.389,
cross_cutting 0.363, temporal 0.276, onboarding 0.428.

Per difficulty NDCG@10: easy 0.354, medium 0.422, hard 0.229.

### CodeMemBench ablation (NDCG@10 delta vs. baseline)

| Config | NDCG@10 | ΔNDCG | HitRate | ΔHit |
|---|---|---|---|---|
| baseline (all strategies) | 0.3511 | — | 78.0% | — |
| no bm25 | 0.3511 | 0.0000 | 78.0% | 0.0% |
| no graph | 0.3511 | 0.0000 | 78.0% | 0.0% |
| no file_path | 0.3363 | −0.0149 | 76.0% | −2.0% |
| no temporal | 0.3511 | 0.0000 | 78.0% | 0.0% |
| **no semantic** | **0.0426** | **−0.3085** | **10.0%** | **−68.0%** |

**Honest reading**: on this dataset's natural-language queries, semantic
similarity is the load-bearing strategy. BM25, graph, and temporal contribute
zero measurable NDCG — the paraphrased queries rarely contain the exact
tokens that FTS5 or tag walks trigger on. File-path helps modestly on the
file-specific category. The lesson is **not** "kill BM25/graph/temporal";
it's that CodeMemBench's synthetic queries don't stress those paths. On
LongMemEval (decision 010), BM25 + graph carried much more weight because
the queries used exact entity names.

Future work: generate a second CodeMemBench slice where queries retain more
exact tokens, specifically to measure BM25's contribution. The current slice
is honest about what it shows.

### CoIR (4 of 10 subtasks, embedding-only, all-MiniLM-L6-v2)

Run completed in 33 min on an M-series Mac, 2026-04-12.

| Subtask | NDCG@10 | Recall@10 | MAP@10 |
|---|---|---|---|
| stackoverflow-qa | **0.8396** | 0.9263 | 0.8138 |
| codefeedback-st  | **0.6599** | 0.8172 | 0.6150 |
| codefeedback-mt  | **0.3562** | 0.4677 | 0.3287 |
| cosqa            | **0.3273** | 0.5640 | 0.2684 |
| **mean (subset)** | **0.5458** | **0.6938** | **0.5065** |

Interpretation: this is a vanilla `all-MiniLM-L6-v2` embedding-only floor —
no re-ranker, no hybrid, no cross-encoder. Results are strong on the two
"natural-language question → short answer" tasks (stackoverflow-qa,
codefeedback-st) and weaker on the long-form / multi-turn tasks
(codefeedback-mt, cosqa) where a 384-d MiniLM checkpoint struggles to
separate near-duplicate corpus candidates.

The `--pipeline` mode (`bun run benchmark:coir:pipeline`) exercises the full
Gyst hybrid stack (BM25 + graph + temporal + file-path + semantic, fused
through RRF) against the same 4 subtasks. That mode is slow (20–40 min)
and is the next thing to run for a direct comparison against this floor.

**Do not** compare the subset mean (0.5458) to the full-CoIR leaderboard
mean. We're running 4 of 10 subtasks — every published number must carry
that caveat.

### LongMemEval (context — from decision 010)

| Metric | Value |
|---|---|
| Questions | 500 |
| Hit@5 | 94.2% |
| MRR@5 | 0.8369 |
| Recall@5 | 0.8676 |

## What this gives us

- **CoIR number**: credibility anchor. "Same embedding model competitive on
  a leaderboard we didn't build."
- **CodeMemBench number**: category definition. "Here's the first benchmark
  for knowledge-about-code retrieval. Here's our score. Here's the dataset.
  Run your system."
- **Ablation**: honest signal about which strategies matter on
  natural-language queries. Informs future retrieval work.
- **LongMemEval baseline unchanged**: 94.2% remains the headline memory
  number.

## Caveats (disclose in launch materials)

1. CoIR: **4 of 10 subtasks**. Mean is not directly comparable to the full
   leaderboard.
2. CodeMemBench: **self-built dataset**. Fairness statement in README.
3. Pipeline mode is slow (20–40 min wall-clock) — embedded-only mode runs
   in CI, pipeline mode is hand-run.
4. Semantic carries the benchmark: document this publicly so we're not
   accused of hiding ablation results.

## References

- `src/store/hybrid.ts` — shared 5-strategy + RRF helper
- `tests/benchmark/codememb/` — dataset, runner, ablation, README
- `tests/benchmark/coir/` — Python adapter, pipeline bridge
- `tests/benchmark/combined-report.ts` — launch-ready summary
- `benchmark-coir.json`, `benchmark-codememb.json`, `benchmark-combined.json`
  (repo root)
- Decision 010 (LongMemEval baseline)
