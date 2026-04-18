/**
 * Local-only usage analytics for Gyst.
 *
 * All data stays in the project's own SQLite database — nothing is ever
 * transmitted externally. The dashboard reads these rows to show retrieval
 * and learning stats without any auth or opt-in requirement.
 *
 * Inspired by claude-mem's "Context Economics": track work invested vs.
 * tokens saved on retrieval to prove the knowledge base is earning its keep.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initAnalyticsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_metrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT    NOT NULL,
      result_count INTEGER,
      token_proxy  INTEGER,
      intent       TEXT,
      zero_result  INTEGER,
      entry_type   TEXT,
      scope        TEXT,
      team_mode    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_metrics_event ON usage_metrics(event_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_metrics_created ON usage_metrics(created_at)`);
}

// ---------------------------------------------------------------------------
// Intent bucket classifier (local, no query text stored or transmitted)
// ---------------------------------------------------------------------------

export type IntentBucket = "temporal" | "debugging" | "code_quality" | "conceptual";

const DEBUGGING_RE = /\b(error|bug|fail|crash|exception|broken|fix|stack|trace|why|wrong)\b/i;
const TEMPORAL_RE  = /\b(recent|last|latest|yesterday|today|history|ago|week|month)\b/i;
const QUALITY_RE   = /\b(convention|pattern|best.?practice|style|lint|refactor|clean|format|standard)\b/i;

/** Classifies query intent locally. The query text is never stored. */
export function classifyIntent(query: string): IntentBucket {
  if (DEBUGGING_RE.test(query)) return "debugging";
  if (TEMPORAL_RE.test(query))  return "temporal";
  if (QUALITY_RE.test(query))   return "code_quality";
  return "conceptual";
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export interface RecallMetric {
  resultCount: number;
  /** Byte length of formatted response ÷ 4 — proxy for tokens delivered. */
  tokenProxy: number;
  intent: IntentBucket;
  zeroResult: boolean;
  teamMode: boolean;
}

export function trackRecall(db: Database, m: RecallMetric): void {
  try {
    db.run(
      `INSERT INTO usage_metrics (event_type, result_count, token_proxy, intent, zero_result, team_mode)
       VALUES ('recall', ?, ?, ?, ?, ?)`,
      [m.resultCount, m.tokenProxy, m.intent, m.zeroResult ? 1 : 0, m.teamMode ? 1 : 0],
    );
  } catch {
    // analytics must never affect product behaviour
  }
}

export interface LearnMetric {
  entryType: string;
  scope: string;
  /** Rough tokens invested in the content being stored (byte length ÷ 4). */
  tokenInvestment: number;
  teamMode: boolean;
}

export function trackLearn(db: Database, m: LearnMetric): void {
  try {
    db.run(
      `INSERT INTO usage_metrics (event_type, token_proxy, entry_type, scope, team_mode)
       VALUES ('learn', ?, ?, ?, ?)`,
      [m.tokenInvestment, m.entryType, m.scope, m.teamMode ? 1 : 0],
    );
  } catch {
    // analytics must never affect product behaviour
  }
}

// ---------------------------------------------------------------------------
// Read helpers — used by the dashboard API
// ---------------------------------------------------------------------------

export interface AnalyticsSummary {
  /** Total recall calls ever recorded. */
  totalRecalls: number;
  /** Total learn calls ever recorded. */
  totalLearns: number;
  /** Total tokens delivered by recall responses (proxy). */
  totalTokensDelivered: number;
  /** Total tokens invested in stored knowledge (proxy). */
  totalTokensInvested: number;
  /**
   * Savings ratio: tokens delivered ÷ tokens invested.
   * >1 means the knowledge base is paying off (each recall surfaces
   * more context than the cost of the entry itself).
   */
  leverageRatio: number;
  /** Percentage of recalls that returned zero results. */
  zeroResultRate: number;
  /** Average results per recall. */
  avgResultsPerRecall: number;
  /** Distribution of intent buckets across all recalls. */
  intentBreakdown: Record<string, number>;
  /** Recalls in the last 24 hours. */
  recallsToday: number;
  /** Learns in the last 24 hours. */
  learnsToday: number;
}

export function getAnalyticsSummary(db: Database): AnalyticsSummary {
  try {
    initAnalyticsSchema(db); // idempotent — safe to call on every read

    interface TotalsRow {
      totalRecalls: number;
      totalLearns: number;
      totalTokensDelivered: number;
      totalTokensInvested: number;
      zeroResults: number;
      totalResults: number;
    }
    const totals = db.query<TotalsRow, []>(`
      SELECT
        COALESCE(SUM(CASE WHEN event_type = 'recall' THEN 1 ELSE 0 END), 0) AS totalRecalls,
        COALESCE(SUM(CASE WHEN event_type = 'learn'  THEN 1 ELSE 0 END), 0) AS totalLearns,
        COALESCE(SUM(CASE WHEN event_type = 'recall' THEN token_proxy ELSE 0 END), 0) AS totalTokensDelivered,
        COALESCE(SUM(CASE WHEN event_type = 'learn'  THEN token_proxy ELSE 0 END), 0) AS totalTokensInvested,
        COALESCE(SUM(CASE WHEN event_type = 'recall' AND zero_result = 1 THEN 1 ELSE 0 END), 0) AS zeroResults,
        COALESCE(SUM(CASE WHEN event_type = 'recall' THEN result_count ELSE 0 END), 0) AS totalResults
      FROM usage_metrics
    `).get() ?? { totalRecalls: 0, totalLearns: 0, totalTokensDelivered: 0, totalTokensInvested: 0, zeroResults: 0, totalResults: 0 };

    interface TodayRow { recallsToday: number; learnsToday: number }
    const today = db.query<TodayRow, []>(`
      SELECT
        COALESCE(SUM(CASE WHEN event_type = 'recall' THEN 1 ELSE 0 END), 0) AS recallsToday,
        COALESCE(SUM(CASE WHEN event_type = 'learn'  THEN 1 ELSE 0 END), 0) AS learnsToday
      FROM usage_metrics
      WHERE created_at >= datetime('now', '-24 hours')
    `).get() ?? { recallsToday: 0, learnsToday: 0 };

    interface IntentRow { intent: string; n: number }
    const intentRows = db.query<IntentRow, []>(`
      SELECT intent, COUNT(*) AS n
      FROM usage_metrics
      WHERE event_type = 'recall' AND intent IS NOT NULL
      GROUP BY intent
    `).all();

    const intentBreakdown: Record<string, number> = {};
    for (const row of intentRows) intentBreakdown[row.intent] = row.n;

    const leverage = totals.totalTokensInvested > 0
      ? Number((totals.totalTokensDelivered / totals.totalTokensInvested).toFixed(2))
      : 0;

    const zeroResultRate = totals.totalRecalls > 0
      ? Number(((totals.zeroResults / totals.totalRecalls) * 100).toFixed(1))
      : 0;

    const avgResults = totals.totalRecalls > 0
      ? Number((totals.totalResults / totals.totalRecalls).toFixed(1))
      : 0;

    return {
      totalRecalls:        totals.totalRecalls,
      totalLearns:         totals.totalLearns,
      totalTokensDelivered: totals.totalTokensDelivered,
      totalTokensInvested:  totals.totalTokensInvested,
      leverageRatio:       leverage,
      zeroResultRate,
      avgResultsPerRecall: avgResults,
      intentBreakdown,
      recallsToday:  today.recallsToday,
      learnsToday:   today.learnsToday,
    };
  } catch {
    return {
      totalRecalls: 0, totalLearns: 0,
      totalTokensDelivered: 0, totalTokensInvested: 0,
      leverageRatio: 0, zeroResultRate: 0, avgResultsPerRecall: 0,
      intentBreakdown: {}, recallsToday: 0, learnsToday: 0,
    };
  }
}
