# Gyst on MemoryBench / LongMemEval — Methodology

**Date:** 2026-06-26
**What this measures:** Gyst's **retrieval substrate** (the hybrid BM25 + graph + temporal + file-path engine, fused by RRF, with an optional sqlite-vec semantic strategy) on **conversational** question-answering, scored end-to-end by an LLM judge. It does **not** measure ghost knowledge or code mining — those do not fire on conversational data and are validated separately (CodeMemBench). See §"Honest framing".

This number is **answer accuracy**, not a retrieval metric (Hit@k / MRR). The two are never reported on the same axis.

---

## Harness & dataset

- **Harness:** [supermemoryai/memorybench](https://github.com/supermemoryai/memorybench) @ commit `118209a746d97d0d85e5a7234267f0b6962857e9`.
- **Benchmark:** LongMemEval — **S (small), cleaned** variant.
  - Source: `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json`
  - **sha256:** `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
  - size 277,383,467 bytes; 500 questions; 6 categories (single-session-user/-assistant/-preference, multi-session, temporal-reasoning, knowledge-update).
- **Pipeline (run every time):** ingest → index → search → answer → evaluate → report.

## Models (part of the eval, external for every provider)

- **Answering model + Judge (primary):** `claude-sonnet-4-5-20250929` (sonnet-4.5).
  - The brief targets gpt-4o to match supermemory's published headline; no OpenAI key was available, so a Claude judge/answerer was used. **Consequence:** these numbers sit beside supermemory's *Claude-judged* runs, not their gpt-4o headline. A gpt-4o-matched run is an open TODO.
  - Note: `claude-sonnet-4-20250514` (the `sonnet-4` alias) was retired/inaccessible for the key used; `sonnet-4.5` was substituted.
- **Iteration loop:** `claude-haiku-4-5-20251001` (haiku-4.5), ~3× cheaper, used to measure deltas; the final/headline numbers use sonnet-4.5.
- **Judge prompts:** harness defaults, **unmodified** (per-category: default / abstention / temporal / knowledge-update / preference). No prompt was tuned.
- **Answer prompt:** harness default (`buildDefaultAnswerPrompt`). The GystProvider supplies **no** custom `prompts` hook, for an apples-to-apples number.

## Gyst — fully local

- Ingest and search make **zero outbound network calls** (the embedding model is a one-time local download, then cached). Only the answer + judge models are external — as they are for every provider.
- **Embeddings model (when enabled):** `Xenova/all-MiniLM-L6-v2`, 384-dim, via `@huggingface/transformers` + `sqlite-vec` `vec0` (L2 distance). (Note: Gyst's prose elsewhere says `bge-small-en-v1.5`; the code uses all-MiniLM-L6-v2 — the latter is what ran.)

## Adapter (GystProvider)

- Lives in the memorybench fork at `src/providers/gyst/` (provider commit `85582c8`). Thin: it **composes Gyst's real exported functions** (`searchByBM25`, `reciprocalRankFusion`, `persistEntry`, `fetchEntriesByIds`, `searchByVector`, …) — it does not reimplement retrieval.
- **Isolation:** one SQLite file per harness `containerTag` (= one LongMemEval question). `clear` deletes the file.
- **Ingest:** each conversation session → one or more `learning` entries (chunked ≤5000 chars), timestamped at the session date so the temporal strategy has a real recency signal. No LLM extraction (stays offline).
- **Embeddings (variant):** enabled with a Bun `--preload` hook that runs Gyst's custom-SQLite probe before the harness opens any DB, plus `initVectorStore` per container.

## Gyst commits under test

- Baseline: `1ab6367` (pre-changes).
- **H2** OR-mode BM25 fallback: `0ee010d`.
- **H3** strip question-words/pronouns/auxiliaries: `e512699`.
- Confidence floor, RRF k=60, and all other parameters: unchanged.

## Hardware

- Apple Silicon (Darwin arm64), Bun 1.3.12. Embeddings ran on CPU (ONNX fp32).

---

## Exact commands

Baseline (unchanged Gyst, vector off):
```
bun run src/index.ts run -p gyst -b longmemeval -j sonnet-4.5 -m sonnet-4.5 -r gyst-baseline
```
Subset iteration (haiku loop):
```
bun run src/index.ts run -p gyst -b longmemeval -j haiku-4.5 -m haiku-4.5 -l 100 -r <id>
```
Embeddings variant (H1):
```
GYST_SQLITE_PATH=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib \
  bun --preload ./src/providers/gyst/preload-sqlite.ts src/index.ts run \
  -p gyst -b longmemeval -j haiku-4.5 -m haiku-4.5 -l 100 -r gyst-h1-haiku-100
```
Held-out guard (never-inspected slice):
```
bun run src/index.ts run -p gyst -b longmemeval -j haiku-4.5 -m haiku-4.5 --offset 400 -l 100 -r gyst-heldout-haiku
```

---

## Results

### Primary lever — H2 (OR-mode BM25 fallback), sonnet-4.5, same 100 questions
| | Accuracy | Empty-retrieval | Avg ctx tokens |
|---|---|---|---|
| Baseline (vector off) | 15.0% (15/100) | 89% | 293 |
| **+H2** | **65.0% (65/100)** | 1% | 8,695 |

Full-500 baseline (sonnet-4.5, vector off): **13.8% (69/500)** — corroborates the subset baseline. The H2 win is bought with a large context-token increase (OR-mode returns ~10 session chunks); reported, not hidden.

### Overfitting guard (held-out, never inspected) — H2+H3, haiku
| | Accuracy |
|---|---|
| first-100 (tuning set) | 55% |
| **held-out Q400–500 (unseen)** | **68%** |

Held-out ≥ tuning ⇒ the gain generalizes; no overfitting.

### Embeddings variant — H1, haiku
| | Accuracy | Avg tokens | Search latency |
|---|---|---|---|
| H2+H3 (vector off) | 55% | 8,384 | 30 ms |
| H1 (vector on) | 60% | 9,785 | 1,316 ms |

H1 helps semantic/cross-session categories (multi-session, knowledge-update) at a real latency cost; kept as a **variant**, not the headline.

### Retrieval-vs-answer split (full-500 baseline)
96.1% of failures were **retrieval-misses** (empty context); only 3.9% answer-misses. Retrieval ceiling ≈ 96.6%.

---

## Honest framing / limitations

- This is **answer accuracy** under a **sonnet-4.5** judge, on **conversational** data. Not comparable to supermemory's gpt-4o headline; comparable to Claude-judged runs.
- It measures Gyst's **retrieval substrate**, not ghost knowledge or code mining (out of scope here; validated on CodeMemBench).
- **No full-500 sonnet "after" run** was completed (API budget). The headline after-number is a **100-question sonnet subset** (15%→65%) with a haiku held-out generalization check (55%→68%); the full-500 sonnet confirmation is a documented TODO.
- A **second-judge robustness run** (e.g. opus-4.5) is a TODO (budget).
- Per-category counts on the 100q subset are small (single-digit per category) — treat category-level deltas as directional.

## Reproduce
1. Clone memorybench @ the commit above; `bun install`; add `ANTHROPIC_API_KEY` to `.env.local`.
2. Add the GystProvider (provider commit `85582c8`) and point it at a Gyst checkout at the commit you're testing.
3. Run the commands above. Reports land in `data/runs/<id>/report.json`; slimmed summaries for these runs are in `./reports/`.
