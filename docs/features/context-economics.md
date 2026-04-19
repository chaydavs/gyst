# Context Economics

## Overview

Context Economics measures whether the knowledge base is earning its keep. The core question: for every token of effort invested in storing knowledge, how many tokens of useful context does the system deliver to agents on recall?

This feature is implemented in `src/utils/analytics.ts`. All data is stored in a `usage_metrics` table in the project's own SQLite database. No data is ever transmitted externally.

---

## The Core Metric: Leverage Ratio

```
leverage_ratio = total_tokens_delivered / total_tokens_invested
```

- **tokens_delivered**: sum of `token_proxy` for all `recall` events — the size of formatted recall responses delivered to agents
- **tokens_invested**: sum of `token_proxy` for all `learn` events — the size of knowledge entries stored

A leverage ratio above 1.0 means the knowledge base is delivering more context than was put in — each recall surfaces more information than the cost of the entry. A ratio of 5.0 means every token invested has been returned fivefold to agents.

**Token proxy calculation**: `Math.round(text.length / 4)` — a rough approximation of GPT-style token count from byte length. Used consistently for both delivered and invested calculations so the ratio is meaningful even though the proxy is imprecise.

---

## The `usage_metrics` Table

```sql
CREATE TABLE usage_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT    NOT NULL,      -- 'recall' or 'learn'
  result_count INTEGER,               -- number of entries returned (recall only)
  token_proxy  INTEGER,               -- tokens delivered (recall) or invested (learn)
  intent       TEXT,                  -- intent bucket (recall only)
  zero_result  INTEGER,               -- 1 if recall returned no results
  entry_type   TEXT,                  -- entry type stored (learn only)
  scope        TEXT,                  -- scope of stored entry (learn only)
  team_mode    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### Writing Recall Events (`trackRecall`)

Called at the end of every `recall` tool invocation with:
- `resultCount`: number of entries returned
- `tokenProxy`: `Math.round(formatted.length / 4)` — size of the formatted response
- `intent`: classified bucket (`temporal`, `debugging`, `code_quality`, `conceptual`)
- `zeroResult`: true if no entries were found
- `teamMode`: whether running in team mode

### Writing Learn Events (`trackLearn`)

Called at the end of every `learn` tool invocation with:
- `entryType`: the type of entry stored
- `scope`: the resolved scope
- `tokenInvestment`: `Math.round(safeContent.length / 4)` — size of the stored content
- `teamMode`: whether running in team mode

Both functions swallow all errors — analytics must never affect product behavior.

---

## Analytics Summary (`getAnalyticsSummary`)

The dashboard API calls `getAnalyticsSummary(db)` to populate the Context Economics panel. The function runs two aggregate SQL queries:

### All-time totals

```sql
SELECT
  SUM(CASE WHEN event_type = 'recall' THEN 1 ELSE 0 END)             AS totalRecalls,
  SUM(CASE WHEN event_type = 'learn'  THEN 1 ELSE 0 END)             AS totalLearns,
  SUM(CASE WHEN event_type = 'recall' THEN token_proxy ELSE 0 END)   AS totalTokensDelivered,
  SUM(CASE WHEN event_type = 'learn'  THEN token_proxy ELSE 0 END)   AS totalTokensInvested,
  SUM(CASE WHEN event_type = 'recall' AND zero_result = 1 THEN 1 ELSE 0 END) AS zeroResults,
  SUM(CASE WHEN event_type = 'recall' THEN result_count ELSE 0 END)  AS totalResults
FROM usage_metrics
```

### Last 24 hours

```sql
SELECT
  SUM(CASE WHEN event_type = 'recall' THEN 1 ELSE 0 END) AS recallsToday,
  SUM(CASE WHEN event_type = 'learn'  THEN 1 ELSE 0 END) AS learnsToday
FROM usage_metrics
WHERE created_at >= datetime('now', '-24 hours')
```

### Returned `AnalyticsSummary`

```typescript
interface AnalyticsSummary {
  totalRecalls: number;
  totalLearns: number;
  totalTokensDelivered: number;
  totalTokensInvested: number;
  leverageRatio: number;          // delivered / invested, 2 decimal places
  zeroResultRate: number;         // percentage, 1 decimal place
  avgResultsPerRecall: number;    // 1 decimal place
  intentBreakdown: Record<string, number>;  // count per intent bucket
  recallsToday: number;
  learnsToday: number;
}
```

---

## Intent Classification

Intent is classified locally from the recall query text at the time of the recall call. The query text itself is never stored — only the classified bucket. Four buckets:

| Bucket | Regex Match |
|--------|------------|
| `debugging` | error, bug, fail, crash, exception, broken, fix, stack, trace, why, wrong |
| `temporal` | recent, last, latest, yesterday, today, history, ago, week, month |
| `code_quality` | convention, pattern, best practice, style, lint, refactor, clean, format, standard |
| `conceptual` | (default when no other bucket matches) |

The `intentBreakdown` field in `AnalyticsSummary` shows how queries are distributed across these buckets — useful for understanding how the team uses the knowledge base. A high `conceptual` ratio suggests the KB is used for architectural reference; a high `debugging` ratio suggests it is primarily a bug fix library.

---

## Zero-Result Rate

```
zeroResultRate = (zeroResults / totalRecalls) * 100
```

A high zero-result rate means agents are asking questions the knowledge base can't answer. This is a drift signal — it indicates the KB is not keeping up with the team's actual queries. The drift detection system (see `docs/features/drift-detection.md`) tracks zero-result rate trend over 7-day vs. 30-day windows.

---

## Dashboard Panel

The Context Economics section of the dashboard displays:
- Leverage ratio (with a visual indicator — green when >1.0)
- Total token savings (tokens delivered minus tokens invested)
- Zero-result rate percentage
- Today's recall and learn counts
- Intent breakdown as a small bar chart or pie

The panel refreshes automatically via the `/api/analytics` endpoint which calls `getAnalyticsSummary(db)`.
