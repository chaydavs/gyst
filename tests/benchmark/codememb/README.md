# CodeMemBench

**The first public benchmark for retrieving *knowledge about code*.**

CodeMemBench measures whether a retrieval system can surface the *reasoning,
conventions, error patterns, decisions, and ghost knowledge* that a team has
accumulated around a codebase — not whether it can find a snippet of source
code. This is a category no existing code-retrieval benchmark (CoIR,
CodeSearchNet, BEIR) measures, because none of them were designed for it.

## Why this exists

AI coding agents make every developer faster, but they do not make the *team*
smarter. Every agent starts from zero on every machine. The knowledge a team
has built up — why auth middleware was rewritten, which error strings mean
"redeploy the Stripe webhook", what the ghost rule is about not passing
`null` into the Prisma upsert path — lives in Slack threads, git commit
bodies, post-mortems, and individual heads. No one has published a dataset
or a metric for retrieving it.

Gyst is the team-knowledge layer for AI agents. CodeMemBench is how we (and
anyone else) measure whether a team-knowledge layer actually works.

## Fairness statement (read this first)

This benchmark was built by the authors of Gyst. **We disclose that upfront
in every launch material.** The purpose is to *define the category* so that
other systems can compete on the same dataset — not to claim a leaderboard
win over systems that were never built for this task.

Methodology is ground-truth-by-construction, not grade-your-own-homework:

1. **Entries are synthesized first** from realistic templates for each of
   8 knowledge categories (error patterns, conventions, decisions, learnings,
   ghost knowledge, deprecations, migrations, runbooks).
2. **Queries are generated *from* entries** — each query pulls 2–4 content
   words from 1–3 specific target entries and paraphrases them naturally.
3. **`relevantEntryIds` is set deterministically at generation time**, not
   graded after retrieval. We never rate our own retrieval.
4. **Queries are stratified by difficulty** — easy (exact keywords),
   medium (paraphrased), hard (cross-cutting / requires graph or temporal).
5. **The dataset is committed to this repo** (`dataset.json`). Any retrieval
   system can run against it and compare apples-to-apples.

If your system can beat Gyst on this dataset, publish your number. The
category is open.

## Dataset

- `dataset.json` — 500 synthetic team-knowledge entries + 200 queries
- 8 categories: `error_resolution`, `convention_lookup`, `decision_rationale`,
  `ghost_knowledge`, `file_specific`, `cross_cutting`, `temporal`, `onboarding`
- 3 difficulty levels: 72 easy / 80 medium / 48 hard
- Generator is deterministic: mulberry32 PRNG seeded at 42
- Re-generate with: `bun run benchmark:codememb:generate`

Entry schema (matches Gyst's `EntryRow`):

```ts
{
  id: string;
  type: "error_pattern" | "convention" | "decision" | "learning" | "ghost_knowledge";
  title: string;
  content: string;
  files: string[];        // file paths the entry describes
  tags: string[];          // freeform tags (stack, area, severity, category)
  confidence: number;      // 0..1
  errorSignature?: string; // normalized sig for error_pattern entries
  ...
}
```

Query schema:

```ts
{
  id: string;
  text: string;              // natural-language query
  category: string;          // one of the 8 categories above
  difficulty: "easy" | "medium" | "hard";
  relevantEntryIds: string[]; // ground truth — set at generation time
  fileContext?: string[];    // optional — when a query has file context
  typeFilter?: string;       // optional — when the user wants a specific type
}
```

## Running

```bash
# Regenerate the dataset (deterministic)
bun run benchmark:codememb:generate

# Run the benchmark against Gyst's full hybrid pipeline
bun run benchmark:codememb

# Run the strategy ablation (which of the 5 strategies actually matter)
bun run benchmark:codememb:ablation
```

Outputs:

- `tests/benchmark/codememb/results.json` — full per-query + aggregate report
- `benchmark-codememb.json` (repo root) — same report, launch-ready location
- `tests/benchmark/codememb/ablation.json` — ablation comparison

## Metrics

All metrics computed at `k=10`:

- **NDCG@10** — ranking quality (primary)
- **Recall@10** — did we surface *any* relevant entry in the top 10
- **MRR@10** — how high the first relevant result sits
- **Hit Rate** — fraction of queries where at least one relevant entry was
  in the top 10

## Comparing other systems

If you want to compete:

1. `git clone` this repo, read `tests/benchmark/codememb/dataset.json`
2. Run your retrieval system against the `entries` and the `queries`
3. For each query, produce a ranked list of entry IDs
4. Compute NDCG@10 / Recall@10 / MRR@10 the same way — see
   `run.ts` for reference implementations
5. Report your number with a link back to this dataset version

The dataset is versioned (`version` field in `dataset.json`). Pin your
number to a version so comparisons stay apples-to-apples when we extend
the dataset.

## Citation

```
@software{gyst_codememb_2026,
  title  = {CodeMemBench: Benchmarking Retrieval of Team Knowledge About Code},
  author = {Gyst team},
  year   = {2026},
  url    = {https://github.com/chaitanyadavuluri/SustainableMemory}
}
```

## Related

- `tests/benchmark/longmemeval/` — LongMemEval Hit@5 on general long-term
  memory (Gyst = 94.2% on 500 questions)
- `tests/benchmark/coir/` — CoIR (ACL 2025) code retrieval, embedding-only
  and full-pipeline modes
