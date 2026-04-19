# AI Drift Detection

## Overview

Drift is when the knowledge base slowly becomes less useful without obviously breaking. Queries return fewer results. Entries age without confirmation. The team stops contributing but keeps recalling. None of these signal an error — they just mean the KB is falling behind.

The drift detection system (`src/utils/drift.ts`) measures this with two mechanisms:

1. **Drift snapshots** — daily point-in-time metrics stored in `drift_snapshots`
2. **Anchor queries** — golden probe queries stored in `anchor_queries` that must always return results

These feed a `computeDriftReport()` function that produces a score from 0.0 (healthy) to 1.0 (severe drift) with specific recommendations.

---

## Database Schema

### `drift_snapshots` Table

Point-in-time recall quality metrics, one row per day.

```sql
CREATE TABLE drift_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  zero_result_rate REAL    NOT NULL,   -- fraction of recalls that returned 0 results
  avg_results      REAL    NOT NULL,   -- average number of results per recall
  recall_count     INTEGER NOT NULL,   -- total recalls recorded
  learn_count      INTEGER NOT NULL,   -- total learns recorded
  leverage_ratio   REAL    NOT NULL,   -- tokens_delivered / tokens_invested
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### `anchor_queries` Table

User-defined probe queries that should always return at least one result.

```sql
CREATE TABLE anchor_queries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  query        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_checked TEXT,
  last_ok      INTEGER NOT NULL DEFAULT 1    -- 1 = passed last check, 0 = failed
);
```

---

## Taking Snapshots

**Function**: `takeDriftSnapshot(db)`

Called automatically by the `PostCompact` hook (`plugin/scripts/post-compact.js`) after context compaction, and can be triggered by the `session_end` event handler.

The function is idempotent within a calendar day — it checks whether a snapshot already exists for the current day before inserting:

```sql
SELECT COUNT(*) AS n FROM drift_snapshots
WHERE created_at >= datetime('now', 'start of day')
```

If a snapshot already exists, the function returns without writing. This prevents multiple snapshots per day from skewing trend analysis.

The snapshot aggregates all-time cumulative metrics from `usage_metrics` at the moment it is taken — not a delta. Trend analysis computes the difference between two snapshots.

---

## Anchor Queries

Anchors are user-defined "golden" probe queries — things that must always be in the knowledge base. Examples:
- `"SQLite WAL mode"`
- `"authentication middleware"`
- `"deployment checklist"`

**Managing anchors**:
```typescript
addAnchorQuery(db, query)      // adds, ignores duplicates
removeAnchorQuery(db, query)   // removes by text
listAnchorQueries(db)          // returns all with last_ok status
```

**Pulse check** (`runAnchorChecks(db)`):

For each anchor, runs a BM25 query against `entries_fts` with a minimum confidence threshold of 0.15:

```sql
SELECT e.id FROM entries e
JOIN entries_fts f ON e.rowid = f.rowid
WHERE f.entries_fts MATCH ?
  AND e.confidence >= 0.15
LIMIT 1
```

Updates `last_checked` and `last_ok` for each anchor. Returns `AnchorResult[]` with `found: boolean` for each.

Anchor checks run on every call to `computeDriftReport()` — not on a schedule — so they always reflect the current state of the index.

---

## Computing the Drift Report

**Function**: `computeDriftReport(db): DriftReport`

Compares a 7-day recent window against a 30-day baseline window, both queried live from `usage_metrics`. Four signals contribute to the score:

### Signal 1: Zero-Result Rate Trend (weight: 0.35)

```
delta = recent7d.zeroResultRate - baseline30d.zeroResultRate
```

Fires when `recent7d.recallCount >= 5` and `delta > 0.1` (10 percentage points increase).

Recommendation: "Zero-result rate rose Xpp in 7d — KB is missing recent query patterns."

### Signal 2: Average Results Declining (weight: 0.25)

```
avgDelta = (recent.avgResults - baseline.avgResults) / baseline.avgResults
```

Fires when `recent7d.recallCount >= 5` and `avgDelta < -0.2` (20% decline in average results per recall).

Recommendation: "Average results per recall dropped X% — entries may be decaying."

### Signal 3: Stale Entries (weight: up to 0.20)

Counts entries that are low-confidence and unconfirmed for 30+ days:

```sql
SELECT COUNT(*) AS n FROM entries
WHERE confidence < 0.4
  AND datetime(last_confirmed) < datetime('now', '-30 days')
  AND scope != 'archived'
```

Fires when `staleCount > 3`. Contributes `min(0.20, staleCount * 0.02)` to the score.

Recommendation: "N entries have low confidence and haven't been confirmed in 30+ days."

### Signal 4: AI Fatigue (weight: 0.20)

Fires when `recent7d.recallCount >= 10` AND `recent7d.learnCount === 0` — the team is using the knowledge base heavily but not contributing anything new. This indicates that learning is outsourced to the AI rather than fed back into the KB.

The `fatigueWarning: boolean` field on the `DriftReport` reflects this signal independently.

Recommendation: "No new entries added in 7 days despite N recalls — AI fatigue risk."

### Anchor Check (weight: up to 0.30)

Runs `runAnchorChecks(db)`. For each broken anchor (one that returns 0 results), adds 0.1 to the score (capped at 0.30 total from anchors).

Recommendation: "N anchor queries returned 0 results — targeted knowledge loss detected."

### Score Computation

The final score is the sum of all contributing signals, clamped to `[0.0, 1.0]` and rounded to 2 decimal places.

### Trend Classification

```
unknown   — insufficient data (< 5 recent recalls or < 10 baseline recalls)
improving — score < 0.10
stable    — score 0.10–0.29
drifting  — score >= 0.30
```

---

## The `DriftReport` Type

```typescript
interface DriftReport {
  score: number;              // 0.0 (healthy) to 1.0 (severe drift)
  trend: DriftTrend;          // "improving" | "stable" | "drifting" | "unknown"
  recent7d: DriftWindow;      // last 7 days: zeroResultRate, avgResults, recalls, learns
  baseline30d: DriftWindow;   // last 30 days: same fields
  staleEntries: number;       // count of low-confidence, unconfirmed entries
  fatigueWarning: boolean;    // true when recalls >> learns
  anchorResults: AnchorResult[];  // per-anchor pass/fail
  recommendations: string[];  // human-readable next steps
}
```

If no signals fire, `recommendations` contains a single healthy message: "Knowledge base looks healthy."

---

## Dashboard Panel

The Knowledge Drift section of the dashboard displays:
- Drift score as a color-coded pill (green <0.1, yellow 0.1–0.3, red >0.3)
- Trend label
- Stale entry count with a link to the review queue
- Fatigue warning banner when active
- Anchor query manager: list of anchors with their `last_ok` status, add/remove controls

The panel fetches from `/api/drift` which calls `computeDriftReport(db)` on every request.
