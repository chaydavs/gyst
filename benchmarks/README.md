# Benchmarks

## LongMemEval (via supermemory's MemoryBench) — retrieval substrate

We ran Gyst's retrieval engine through a standard third-party harness
([supermemoryai/memorybench](https://github.com/supermemoryai/memorybench)) on the
**LongMemEval-S** conversational QA dataset, scored end-to-end by an LLM judge.

**What this is.** A measurement of Gyst's **retrieval substrate** — hybrid BM25 +
graph + temporal + file-path retrieval, fused with Reciprocal Rank Fusion, with an
optional local `sqlite-vec` semantic strategy — on **conversational** data. The
number below is **answer accuracy** (LLM-judged), **not** a retrieval metric
(Hit@k/MRR); we never put the two on the same axis.

**What this is not.** It is *not* a measure of Gyst's ghost knowledge or code-mining
phases — those are designed for engineering sessions and do not fire on
conversational chit-chat. They are validated separately on CodeMemBench. LongMemEval
exercises only the embeddings/keyword retrieval substrate.

### Headline

| | Accuracy (LLM-judged) |
|---|---|
| Baseline (unchanged Gyst, vector off) | **15%** on a 100-question sonnet-4.5 subset · **13.8%** on full 500 |
| **+ OR-mode BM25 fallback (H2) + stop-word fix (H3)** | **65%** on the 100-question sonnet-4.5 subset |
| Held-out check (100 never-inspected questions, haiku) | **55% → 68%** — gain generalizes, no overfitting |
| Embeddings variant (sqlite-vec, haiku) | **+5 pts**, at ~1.3 s/query search latency |

The dominant fix was a single mechanism: Gyst's FTS5 BM25 used implicit-AND, so
natural-language questions ("how long have I collected cameras?") required every
term to co-occur and returned **nothing** 89% of the time. Adding an OR-mode
fallback when the AND match is empty dropped the empty-retrieval rate to ~1% and
lifted accuracy from 15% to 65% on the subset.

### Honest caveats

- The judge and answering model are **Claude sonnet-4.5**, not gpt-4o. These numbers
  sit beside Claude-judged runs, **not** supermemory's gpt-4o headline. A
  gpt-4o-matched run is a TODO.
- The H2 win raises retrieved-context tokens substantially (OR-mode returns more
  chunks); accuracy is always reported with its token/latency cost.
- The headline "after" number is a **100-question** sonnet subset (with a haiku
  held-out generalization check); a **full-500 sonnet** confirmation is a documented,
  budget-gated TODO.
- A second-judge robustness run (opus-4.5) is a TODO.

Full reproducibility — exact commands, dataset sha256, model versions, commit
hashes, hardware — is in [`METHODOLOGY.md`](./METHODOLOGY.md). Analysis and the
per-change changelog are in [`ANALYSIS.md`](./ANALYSIS.md) and
[`IMPROVEMENTS.md`](./IMPROVEMENTS.md); slimmed run summaries are in
[`reports/`](./reports/).
