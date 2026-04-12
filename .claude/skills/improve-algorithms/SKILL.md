---
name: improve-algorithms
description: Analyzes current algorithms in Gyst and proposes specific improvements based on real eval data. Use when the user says "improve," "optimize," "better search," "fix retrieval," "algorithm," "brainstorm," or when eval metrics show degradation. Also use after running retrieval-eval.ts.
allowed-tools: Read, Bash, Grep, Glob
paths: "src/store/**/*.ts, src/compiler/**/*.ts, tests/eval/**/*.ts"
---

# Algorithm Improvement Process

You are analyzing Gyst's core algorithms to find concrete improvements.
Do NOT suggest theoretical changes. Every suggestion must be testable
against the eval harness (`tests/eval/retrieval-eval.ts`).

## Step 1: Read Current Eval Results

```bash
bun run eval
# Or read cached results
cat tests/eval/results.json
```

Baseline (before query expansion): MRR@5=0.724, Recall@5=0.690, NDCG@5=0.682

## Step 2: Identify Failure Modes

Read `tests/eval/results.json` and group failures by cause:

- **VOCABULARY MISMATCH**: query uses different words than entry (needs embeddings or synonyms)
- **MISSING LINKS**: entry exists but graph has no path to it (needs better linking)
- **BM25 NOISE**: irrelevant entries ranked higher than relevant ones (needs weight tuning)
- **SCOPE FILTERING**: personal entries leaked or team entries missed
- **TOKENIZATION**: code identifiers not split correctly

## Step 3: Propose and Test One Change at a Time

For each proposed improvement:

1. Write the change
2. Run `bun run eval`
3. Compare MRR@5 before and after
4. If improved: keep it, update baseline
5. If degraded: revert it, document why in `decisions/`

## Known Improvement Targets

### Target 1: Natural-language "why" queries
12 of 50 eval queries were complete misses — all "why did we..." queries.
Addressed by `src/store/query-expansion.ts` (synonym map). If still failing,
consider query rewriting or sqlite-vec embeddings as 4th search strategy.

### Target 2: BM25 column weights
Current: title=10, content=5, error_sig=1.
`tests/eval/tune-weights.ts` grid-searches 96 configurations — run it and
check if the current weights are optimal.

### Target 3: Graph traversal depth
Current max depth: 1 hop (seeds + neighbours). Might need depth 2 for
transitive relationships. Test against eval.

### Target 4: RRF k parameter
Current k=60 (Cormack et al. 2009 default). Research suggests k=30 may
work better for small result sets. Test k ∈ {20, 30, 45, 60, 90}.

### Target 5: Error normalization grouping accuracy
No formal measurement yet. After collecting real errors, measure false
positive and false negative rates. False positives (different errors
grouped) are worse than false negatives (duplicates can be merged later).

### Target 6: Confidence calibration
Use the `feedback` MCP tool + `scripts/calibrate-confidence.ts` to compare
predicted confidence with actual usefulness. Adjust half-lives based on
bucket-wise positive rates.

## Step 4: Document Every Change

Create a file in `decisions/` for every algorithm change:

```markdown
# Decision: [Changed X from Y to Z]
Date: [date]
Status: Accepted / Rejected

## Baseline
MRR@5: 0.724, Recall@5: 0.690, NDCG@5: 0.682

## Change
[what was changed and why]

## Result
MRR@5: [new], Recall@5: [new], NDCG@5: [new]
Delta: [+/- for each metric]

## Conclusion
[Keep or revert, and why]
```

## Self-Hosted LLM Specific Improvements

Self-hosted models have smaller context windows (32K-64K vs 200K).
Recall responses need to be compressed:

- Current token budget: 5000 tokens max per recall response
- Compact mode: 2000 tokens for Ollama defaults (4K context)
- Prioritize higher-confidence entries when budget is tight
- Add `context_budget` parameter to the recall tool input
- Test: does reducing from 5000 to 2000 tokens hurt usefulness?

## Anti-Patterns

- Don't tune against the eval set you evaluate on — use a held-out set
- Don't chase 1% MRR improvements with complex changes
- Don't add a feature without a metric it improves
- Don't ship a change without a decision record
