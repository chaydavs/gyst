/**
 * Uniformity scoring for the Gyst knowledge base.
 *
 * Computes a 0–100 score representing how comprehensively and consistently
 * team conventions, rules, and decisions are documented across the codebase.
 *
 * The score is a weighted sum of four subscores:
 *   coverage  (40%) — fraction of directories that have ≥1 active convention
 *   ghost     (20%) — inverse of active ghost_knowledge entries (≥5 → 0)
 *   freshness (20%) — how recently conventions were confirmed (decays over 90d)
 *   style     (20%) — fraction of conventions with confidence ≥ 0.8
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A complete uniformity report with score, subscores, and supporting details. */
export interface UniformityReport {
  /** Final weighted score, 0–100, rounded to 1 decimal place. */
  readonly score: number;
  /** Raw subscore components, each in [0, 1]. */
  readonly subscores: {
    readonly coverage: number;
    readonly ghost: number;
    readonly freshness: number;
    readonly style: number;
  };
  /** Supporting statistics that explain the subscores. */
  readonly details: {
    readonly directoriesCovered: number;
    readonly directoriesTotal: number;
    readonly ghostCount: number;
    readonly avgFreshnessDays: number;
    readonly highConfidenceRatio: number;
  };
}

// ---------------------------------------------------------------------------
// Query result row types
// ---------------------------------------------------------------------------

interface FilePathRow {
  readonly file_path: string;
}

interface GhostCountRow {
  readonly n: number;
}

interface FreshnessRow {
  readonly avg_days: number | null;
}

interface StyleRow {
  readonly ratio: number | null;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all distinct file_path values from entry_files.
 * Directory extraction is done in TypeScript to avoid using the non-standard
 * SQLite `reverse()` function which is absent from some system builds.
 */
const SQL_ALL_FILE_PATHS = `
  SELECT DISTINCT file_path FROM entry_files
`;

/**
 * Fetch all distinct file_path values from entry_files that are associated
 * with at least one active convention entry.
 */
const SQL_CONVENTION_FILE_PATHS = `
  SELECT DISTINCT ef.file_path
  FROM entry_files ef
  JOIN entries e ON e.id = ef.entry_id
  WHERE e.type = 'convention' AND e.status = 'active'
`;

const SQL_GHOST_COUNT = `
  SELECT COUNT(*) AS n
  FROM entries
  WHERE type = 'ghost_knowledge' AND status = 'active'
`;

const SQL_AVG_FRESHNESS = `
  SELECT AVG(julianday('now') - julianday(last_confirmed)) AS avg_days
  FROM entries
  WHERE type = 'convention' AND status = 'active'
`;

const SQL_STYLE_RATIO = `
  SELECT AVG(CASE WHEN confidence >= 0.8 THEN 1.0 ELSE 0.0 END) AS ratio
  FROM entries
  WHERE type = 'convention' AND status = 'active'
`;

// ---------------------------------------------------------------------------
// Subscore computations
// ---------------------------------------------------------------------------

/**
 * Extract the directory component from a file path using TypeScript.
 *
 * Avoids the non-standard SQLite `reverse()` function. Returns '.' for
 * paths with no slash (root-level files).
 */
function dirOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : ".";
}

/**
 * Computes the coverage subscore: fraction of known directories that contain
 * at least one active convention entry.
 *
 * File paths are fetched from SQLite and directory extraction is done in
 * TypeScript to avoid relying on the non-standard `reverse()` SQLite function.
 *
 * Returns 0 when no directories are present in entry_files.
 */
function computeCoverage(db: Database): {
  readonly subscore: number;
  readonly covered: number;
  readonly total: number;
} {
  const allPathRows = db.query<FilePathRow, []>(SQL_ALL_FILE_PATHS).all();
  const conventionPathRows = db.query<FilePathRow, []>(SQL_CONVENTION_FILE_PATHS).all();

  const allDirs = new Set(allPathRows.map((r) => dirOf(r.file_path)));
  const coveredDirs = new Set(conventionPathRows.map((r) => dirOf(r.file_path)));

  const total = allDirs.size;
  const covered = coveredDirs.size;

  if (total === 0) {
    return { subscore: 0, covered: 0, total: 0 };
  }

  return { subscore: covered / total, covered, total };
}

/**
 * Computes the ghost subscore: measures how much ghost knowledge has been
 * captured. Five or more ghost_knowledge entries gives a full score of 1.0;
 * zero entries gives 0. The subscore grows linearly: count/5, capped at 1.
 */
function computeGhost(db: Database): {
  readonly subscore: number;
  readonly count: number;
} {
  const row = db.query<GhostCountRow, []>(SQL_GHOST_COUNT).get();
  const count = row?.n ?? 0;
  const subscore = Math.min(count / 5, 1);
  return { subscore, count };
}

/**
 * Computes the freshness subscore: measures how recently conventions were
 * last confirmed. A convention confirmed today scores 1; one confirmed 90
 * days ago scores 0.
 *
 * Returns 1 when there are no active conventions (nothing to go stale).
 */
function computeFreshness(db: Database): {
  readonly subscore: number;
  readonly avgDays: number;
} {
  const row = db.query<FreshnessRow, []>(SQL_AVG_FRESHNESS).get();
  const avgDays = row?.avg_days ?? null;

  if (avgDays === null) {
    return { subscore: 1, avgDays: 0 };
  }

  const subscore = Math.max(0, 1 - avgDays / 90);
  return { subscore, avgDays };
}

/**
 * Computes the style subscore: fraction of active conventions that carry a
 * confidence score of 0.8 or higher.
 *
 * Returns 0.5 (neutral) when there are no active conventions.
 */
function computeStyle(db: Database): {
  readonly subscore: number;
  readonly ratio: number;
} {
  const row = db.query<StyleRow, []>(SQL_STYLE_RATIO).get();
  const ratio = row?.ratio ?? null;

  if (ratio === null) {
    return { subscore: 0.5, ratio: 0.5 };
  }

  return { subscore: ratio, ratio };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes the full uniformity report for the knowledge base.
 *
 * All queries are synchronous (bun:sqlite). The final score is:
 *   (coverage * 0.4 + ghost * 0.2 + freshness * 0.2 + style * 0.2) * 100
 * rounded to one decimal place.
 *
 * @param db   - Open bun:sqlite Database connection.
 * @param opts - Optional configuration (reserved for future rootDir filtering).
 * @returns    A fully populated UniformityReport.
 */
export function computeUniformityScore(
  db: Database,
  opts?: { readonly rootDir?: string },
): UniformityReport {
  // opts is reserved for future use (rootDir scoping); acknowledge to satisfy TS.
  void opts;

  const coverageResult = computeCoverage(db);
  const ghostResult = computeGhost(db);
  const freshnessResult = computeFreshness(db);
  const styleResult = computeStyle(db);

  const { subscore: coverage, covered: directoriesCovered, total: directoriesTotal } = coverageResult;
  const { subscore: ghost, count: ghostCount } = ghostResult;
  const { subscore: freshness, avgDays: avgFreshnessDays } = freshnessResult;
  const { subscore: style, ratio: highConfidenceRatio } = styleResult;

  const rawScore =
    coverage * 0.4 +
    ghost * 0.2 +
    freshness * 0.2 +
    style * 0.2;

  const score = Math.round(rawScore * 1000) / 10;

  return {
    score,
    subscores: { coverage, ghost, freshness, style },
    details: {
      directoriesCovered,
      directoriesTotal,
      ghostCount,
      avgFreshnessDays,
      highConfidenceRatio,
    },
  };
}
