/**
 * AI Drift Detection for Gyst.
 *
 * Drift = a knowledge base slowly becoming less useful without breaking.
 * Three signals identify drift early:
 *
 *  1. Zero-result rate trending up  → KB is getting stale relative to queries
 *  2. Recall:learn ratio > 10:1     → "AI fatigue" — user stopped contributing
 *  3. Stale entries (no confirmation in 30d, confidence < 0.4) → garden needs pruning
 *
 * Anchor queries are golden probe queries stored by the user. The pulse check
 * runs them against BM25 and flags any that return 0 results — those are
 * broken anchors that indicate targeted knowledge loss.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initDriftSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS drift_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      zero_result_rate REAL    NOT NULL,
      avg_results      REAL    NOT NULL,
      recall_count     INTEGER NOT NULL,
      learn_count      INTEGER NOT NULL,
      leverage_ratio   REAL    NOT NULL,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_drift_snapshots_created ON drift_snapshots(created_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS anchor_queries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      query      TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      last_checked TEXT,
      last_ok    INTEGER NOT NULL DEFAULT 1
    )
  `);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftWindow {
  zeroResultRate: number;
  avgResults: number;
  recallCount: number;
  learnCount: number;
}

export interface AnchorResult {
  id: number;
  query: string;
  found: boolean;
}

export type DriftTrend = "improving" | "stable" | "drifting" | "unknown";

export interface DriftReport {
  /** 0.0 = healthy, 1.0 = severe drift */
  score: number;
  trend: DriftTrend;
  recent7d: DriftWindow;
  baseline30d: DriftWindow;
  staleEntries: number;
  /** User recalls > 10x more than they contribute — intuition dulling. */
  fatigueWarning: boolean;
  anchorResults: AnchorResult[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Save a point-in-time snapshot of recall quality metrics.
 * Call once per day (session_end hook is a good trigger).
 * Idempotent within a calendar day — skips if a snapshot already exists today.
 */
export function takeDriftSnapshot(db: Database): void {
  try {
    initDriftSchema(db);

    interface ExistsRow { n: number }
    const already = db.query<ExistsRow, []>(
      `SELECT COUNT(*) AS n FROM drift_snapshots WHERE created_at >= datetime('now', 'start of day')`
    ).get();
    if (already && already.n > 0) return;

    interface MetricsRow {
      recalls: number; learns: number;
      zeroResults: number; totalResults: number;
      tokensDelivered: number; tokensInvested: number;
    }
    const m = db.query<MetricsRow, []>(`
      SELECT
        COALESCE(SUM(CASE WHEN event_type='recall' THEN 1 ELSE 0 END), 0)             AS recalls,
        COALESCE(SUM(CASE WHEN event_type='learn'  THEN 1 ELSE 0 END), 0)             AS learns,
        COALESCE(SUM(CASE WHEN event_type='recall' AND zero_result=1 THEN 1 ELSE 0 END), 0) AS zeroResults,
        COALESCE(SUM(CASE WHEN event_type='recall' THEN result_count ELSE 0 END), 0)  AS totalResults,
        COALESCE(SUM(CASE WHEN event_type='recall' THEN token_proxy ELSE 0 END), 0)   AS tokensDelivered,
        COALESCE(SUM(CASE WHEN event_type='learn'  THEN token_proxy ELSE 0 END), 0)   AS tokensInvested
      FROM usage_metrics
    `).get() ?? { recalls: 0, learns: 0, zeroResults: 0, totalResults: 0, tokensDelivered: 0, tokensInvested: 0 };

    const zeroRate   = m.recalls > 0 ? m.zeroResults  / m.recalls      : 0;
    const avgResults = m.recalls > 0 ? m.totalResults  / m.recalls      : 0;
    const leverage   = m.tokensInvested > 0 ? m.tokensDelivered / m.tokensInvested : 0;

    db.run(
      `INSERT INTO drift_snapshots (zero_result_rate, avg_results, recall_count, learn_count, leverage_ratio)
       VALUES (?, ?, ?, ?, ?)`,
      [zeroRate, avgResults, m.recalls, m.learns, leverage],
    );
  } catch {
    // drift tracking must never affect product behaviour
  }
}

// ---------------------------------------------------------------------------
// Anchor queries
// ---------------------------------------------------------------------------

/** Add a golden probe query. Duplicate queries are silently ignored. */
export function addAnchorQuery(db: Database, query: string): void {
  initDriftSchema(db);
  db.run(
    `INSERT OR IGNORE INTO anchor_queries (query) VALUES (?)`,
    [query.trim()],
  );
}

/** Remove an anchor query by its text. */
export function removeAnchorQuery(db: Database, query: string): void {
  db.run(`DELETE FROM anchor_queries WHERE query = ?`, [query.trim()]);
}

/** List all stored anchor queries. */
export function listAnchorQueries(db: Database): Array<{ id: number; query: string; lastOk: boolean }> {
  initDriftSchema(db);
  interface Row { id: number; query: string; last_ok: number }
  return db.query<Row, []>(`SELECT id, query, last_ok FROM anchor_queries ORDER BY id`).all()
    .map(r => ({ id: r.id, query: r.query, lastOk: r.last_ok === 1 }));
}

/**
 * Run all anchor queries against BM25 full-text search.
 * Updates `last_checked` and `last_ok` for each anchor.
 */
function runAnchorChecks(db: Database): AnchorResult[] {
  initDriftSchema(db);
  interface AnchorRow { id: number; query: string }
  const anchors = db.query<AnchorRow, []>(`SELECT id, query FROM anchor_queries`).all();
  if (anchors.length === 0) return [];

  const results: AnchorResult[] = [];
  for (const anchor of anchors) {
    let found = false;
    try {
      interface FtsRow { id: string }
      const row = db.query<FtsRow, [string]>(
        `SELECT e.id FROM entries e
         JOIN entries_fts f ON e.rowid = f.rowid
         WHERE f.entries_fts MATCH ?
         AND e.confidence >= 0.15
         LIMIT 1`,
      ).get(anchor.query);
      found = row !== null;
    } catch {
      found = false;
    }
    db.run(
      `UPDATE anchor_queries SET last_checked = datetime('now'), last_ok = ? WHERE id = ?`,
      [found ? 1 : 0, anchor.id],
    );
    results.push({ id: anchor.id, query: anchor.query, found });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Drift report
// ---------------------------------------------------------------------------

function queryWindow(db: Database, daysBack: number): DriftWindow {
  interface Row {
    recalls: number; learns: number;
    zeroResults: number; totalResults: number;
  }
  const r = db.query<Row, [string]>(`
    SELECT
      COALESCE(SUM(CASE WHEN event_type='recall' THEN 1 ELSE 0 END), 0)               AS recalls,
      COALESCE(SUM(CASE WHEN event_type='learn'  THEN 1 ELSE 0 END), 0)               AS learns,
      COALESCE(SUM(CASE WHEN event_type='recall' AND zero_result=1 THEN 1 ELSE 0 END), 0) AS zeroResults,
      COALESCE(SUM(CASE WHEN event_type='recall' THEN result_count ELSE 0 END), 0)    AS totalResults
    FROM usage_metrics
    WHERE created_at >= datetime('now', ?)
  `).get(`-${daysBack} days`) ?? { recalls: 0, learns: 0, zeroResults: 0, totalResults: 0 };

  return {
    zeroResultRate: r.recalls > 0 ? r.zeroResults / r.recalls : 0,
    avgResults:     r.recalls > 0 ? r.totalResults / r.recalls : 0,
    recallCount:    r.recalls,
    learnCount:     r.learns,
  };
}

/**
 * Compute a comprehensive drift report comparing recent 7-day window
 * against 30-day baseline. Scores 0.0 (healthy) → 1.0 (severe drift).
 */
export function computeDriftReport(db: Database): DriftReport {
  try {
    initDriftSchema(db);

    const recent   = queryWindow(db, 7);
    const baseline = queryWindow(db, 30);

    const recommendations: string[] = [];
    let score = 0;

    // --- Signal 1: zero-result rate trend ---
    const zeroRateDelta = recent.zeroResultRate - baseline.zeroResultRate;
    if (recent.recallCount >= 5 && zeroRateDelta > 0.1) {
      score += 0.35;
      recommendations.push(
        `Zero-result rate rose ${(zeroRateDelta * 100).toFixed(0)}pp in 7d — KB is missing recent query patterns. Run \`gyst onboard\` or add entries for common queries.`
      );
    }

    // --- Signal 2: avg results declining ---
    const avgDelta = baseline.avgResults > 0
      ? (recent.avgResults - baseline.avgResults) / baseline.avgResults
      : 0;
    if (recent.recallCount >= 5 && avgDelta < -0.2) {
      score += 0.25;
      recommendations.push(
        `Average results per recall dropped ${(Math.abs(avgDelta) * 100).toFixed(0)}% — entries may be decaying. Confirm high-value entries via the review queue.`
      );
    }

    // --- Signal 3: stale entries ---
    interface StaleRow { n: number }
    const staleRow = db.query<StaleRow, []>(`
      SELECT COUNT(*) AS n FROM entries
      WHERE confidence < 0.4
        AND datetime(last_confirmed) < datetime('now', '-30 days')
        AND scope != 'archived'
    `).get();
    const staleCount = staleRow?.n ?? 0;
    if (staleCount > 3) {
      score += Math.min(0.2, staleCount * 0.02);
      recommendations.push(
        `${staleCount} entries have low confidence and haven't been confirmed in 30+ days. Review them before they decay below recall threshold.`
      );
    }

    // --- Signal 4: AI fatigue (recall:learn ratio) ---
    const recentLearnCount = recent.learnCount;
    const fatigueWarning   = recent.recallCount >= 10 && recentLearnCount === 0;
    if (fatigueWarning) {
      score += 0.2;
      recommendations.push(
        `No new entries added in 7 days despite ${recent.recallCount} recalls — AI fatigue risk. Manually add 1–2 entries this week to keep your intuition sharp.`
      );
    }

    // --- Anchor check ---
    const anchorResults = runAnchorChecks(db);
    const brokenAnchors = anchorResults.filter(a => !a.found);
    if (brokenAnchors.length > 0) {
      score += Math.min(0.3, brokenAnchors.length * 0.1);
      recommendations.push(
        `${brokenAnchors.length} anchor quer${brokenAnchors.length === 1 ? "y" : "ies"} returned 0 results — targeted knowledge loss detected. Re-add entries for: ${brokenAnchors.map(a => `"${a.query}"`).join(", ")}`
      );
    }

    // Clamp score
    score = Math.min(1.0, Number(score.toFixed(2)));

    let trend: DriftTrend = "unknown";
    if (recent.recallCount >= 5 && baseline.recallCount >= 10) {
      if (score < 0.1) trend = "improving";
      else if (score < 0.3) trend = "stable";
      else trend = "drifting";
    }

    if (recommendations.length === 0) {
      recommendations.push("Knowledge base looks healthy. Keep capturing learnings after each session.");
    }

    return { score, trend, recent7d: recent, baseline30d: baseline, staleEntries: staleCount, fatigueWarning, anchorResults, recommendations };
  } catch {
    return {
      score: 0, trend: "unknown",
      recent7d:  { zeroResultRate: 0, avgResults: 0, recallCount: 0, learnCount: 0 },
      baseline30d: { zeroResultRate: 0, avgResults: 0, recallCount: 0, learnCount: 0 },
      staleEntries: 0, fatigueWarning: false, anchorResults: [], recommendations: [],
    };
  }
}
