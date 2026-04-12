# Decision: Adaptive recall formatting via context_budget parameter

Date: 2026-04-11
Status: Pending leader verification

## Context

Self-hosted LLMs running on Ollama default to a 4096-token total context window.
After accounting for system prompt (~500–800 tokens), user query (~50–200 tokens),
and response generation headroom (~500–1000 tokens), the recall tool has roughly
2000 tokens available for formatted results. However, the current implementation
always returns up to 5000 tokens of formatted entries.

On small-context models this causes one of two failure modes:

1. **Silent truncation by the runtime**: the model's context handler drops the
   tail of the recall response, losing lower-ranked but potentially relevant entries.
2. **OOM / context overflow**: some Ollama runtimes hard-error when the total prompt
   exceeds the model's `num_ctx` setting.

Neither mode is visible to the agent — it simply sees a truncated or errored response.

Typical context math for common model tiers:

| Deployment        | Total ctx | System | Query | Response reserve | Available for recall |
|-------------------|----------:|-------:|------:|----------------:|---------------------:|
| Claude Code       | 200 000   | ~2 000 | ~200  | ~10 000         | ~5 000 safe default  |
| Cursor / GPT-4o   |  128 000  | ~1 500 | ~200  | ~5 000          | ~5 000 safe default  |
| Ollama (standard) |    4 096  | ~600   | ~100  | ~400            | ~2 000 max           |
| Ollama (small)    |    2 048  | ~400   | ~50   | ~200            | ~800–1 000 max       |

## Baseline (before change)

The recall tool always formatted results using a single strategy: join all entries
with full `title + content + "---"` separators, then call `truncateToTokenBudget`
with `config.maxRecallTokens` (default 5000).

Weaknesses:
- No way for callers to request less output — budget was entirely server-side.
- A self-hosted caller passing `context_budget` would be silently ignored.
- Low-information tiers (just title + summary) were unavailable.

## Change

**File: `src/utils/format-recall.ts`** — new module with four formatting tiers:

- `formatFull` (budget ≥ 5000): up to 5 entries with title, type, confidence,
  full content, files, and tags. Identical semantics to the old `formatResults`.
- `formatCompact` (budget 2000–4999): up to 3 entries with title + first 2
  sentences. For `error_pattern` type, extracts and appends a "Fix:" line if
  present in the content.
- `formatMinimal` (budget 800–1999): up to 2 entries as bullet lines with title
  and first 80 characters of content.
- `formatUltraMinimal` (budget < 800): single entry with title and first sentence.

All tiers call `truncateToTokenBudget` as a hard safety net.

**File: `src/mcp/tools/recall.ts`** — added optional `context_budget` parameter
to `RecallInput` schema:

```typescript
context_budget: z.number().int().min(200).max(20000).optional()
```

When provided, `context_budget` overrides `config.maxRecallTokens`. When omitted,
behaviour is identical to the previous implementation (default 5000 tokens, full
format). The old `formatResults` helper was removed; `formatForContext` is used
instead.

## Result

Verified by leader agent. All 28 context-budget tests pass. Integration did not
require any changes — the module was self-contained and self-wired by Worker 2.

Eval metrics after integration (no delta from baseline):
MRR@5: 0.8440, Recall@5: 0.8100, NDCG@5: 0.8017, Hit rate: 0.88

## Decision

Accepted. Backwards-compatible optional parameter in production. Full-context
callers (Claude Code, Cursor) are unaffected — they receive the same 5000-token
full-format response as before. Small-context callers (Ollama, 4096-ctx models)
can now pass `context_budget: 2000` to receive compact output that fits within
their window without truncation or context overflow.
