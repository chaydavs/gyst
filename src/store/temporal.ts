/**
 * Temporal search strategy: returns entries confirmed within a time window
 * parsed from natural-language phrases in the query.
 *
 * Designed to handle queries like:
 *   - "what changed yesterday"
 *   - "recent errors in auth"
 *   - "decisions from last week"
 *
 * Returns an empty array when no temporal signal is present, so the RRF
 * fusion won't be biased for queries that don't care about time.
 */

import type { Database } from "bun:sqlite";

import { logger } from "../utils/logger.js";
import { SearchError } from "../utils/errors.js";
import type { RankedResult } from "./search.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemporalWindow {
  readonly afterIso: string;
  readonly beforeIso: string;
}

interface TemporalRow {
  id: string;
  days_ago: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses natural-language time references in a query and returns a time
 * window.
 *
 * Recognised phrases (case-insensitive):
 *   - "yesterday"                → 48h–24h ago
 *   - "today", "just now"        → last 12 hours
 *   - "recent", "latest", "recently", "last few days" → last 7 days
 *   - "last week", "this week", "past week"            → last 7 days
 *   - "last month", "this month", "past month"         → last 30 days
 *
 * Returns null when no temporal signal is present.
 *
 * @param query - The raw query string.
 * @param now   - Reference "now" timestamp (injectable for tests).
 * @returns A time window or null.
 */
export function parseTimeReference(
  query: string,
  now: Date = new Date(),
): TemporalWindow | null {
  const q = query.toLowerCase();

  const windowFrom = (
    afterMs: number,
    beforeMs: number = 0,
  ): TemporalWindow => ({
    afterIso: new Date(now.getTime() - afterMs).toISOString(),
    beforeIso: new Date(now.getTime() - beforeMs).toISOString(),
  });

  // Most specific phrases first — yesterday before today, monthly before
  // weekly, weekly before "recent"
  if (/\byesterday\b/.test(q)) {
    return windowFrom(48 * MS_PER_HOUR, 24 * MS_PER_HOUR);
  }
  if (/\b(today|just now)\b/.test(q)) {
    return windowFrom(12 * MS_PER_HOUR);
  }
  if (/\blast month\b|\bthis month\b|\bpast month\b/.test(q)) {
    return windowFrom(30 * MS_PER_DAY);
  }
  if (/\blast week\b|\bthis week\b|\bpast week\b/.test(q)) {
    return windowFrom(7 * MS_PER_DAY);
  }
  if (/\b(recent|latest|recently|last few days)\b/.test(q)) {
    return windowFrom(7 * MS_PER_DAY);
  }

  return null;
}

/**
 * Temporal search strategy.
 *
 * Score formula: 1 / (1 + days_ago). Hyperbolic decay so:
 *   - same day:   score ≈ 1.0
 *   - 1 day ago:  score = 0.5
 *   - 7 days ago: score ≈ 0.125
 *
 * Filters entries by status = 'active' AND scope IN ('team', 'project')
 * for consistency with searchByBM25.
 *
 * @param db    - Open database connection.
 * @param query - The raw user query (time phrases parsed out internally).
 * @param now   - Reference "now" timestamp (injectable for tests).
 * @returns Ranked results. Empty array if no time signal or no matches.
 * @throws {SearchError} If the SQL query fails.
 */
export function searchByTemporal(
  db: Database,
  query: string,
  now: Date = new Date(),
): RankedResult[] {
  if (!query.trim()) {
    return [];
  }

  const window = parseTimeReference(query, now);
  if (window === null) {
    return [];
  }

  logger.debug("searchByTemporal", {
    query,
    after: window.afterIso,
    before: window.beforeIso,
  });

  try {
    const sql = `
      SELECT
        e.id AS id,
        CAST(
          (julianday(?) - julianday(e.last_confirmed)) AS REAL
        ) AS days_ago
      FROM   entries e
      WHERE  e.status = 'active'
        AND  e.last_confirmed >= ?
        AND  e.last_confirmed <= ?
        AND  e.scope IN ('team', 'project')
      ORDER BY e.last_confirmed DESC
      LIMIT 20
    `;

    const rows = db
      .query<TemporalRow, [string, string, string]>(sql)
      .all(now.toISOString(), window.afterIso, window.beforeIso);

    return rows.map((row) => ({
      id: row.id,
      score: 1 / (1 + Math.max(0, row.days_ago)),
      source: "temporal",
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SearchError(`searchByTemporal failed: ${msg}`);
  }
}
