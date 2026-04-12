/**
 * Search implementation for Gyst.
 *
 * Four complementary strategies are provided and fused via Reciprocal Rank
 * Fusion (RRF):
 *
 *  1. **File-path search** — exact lookup against the `entry_files` table.
 *  2. **BM25 / FTS5 search** — full-text search using the `entries_fts`
 *     virtual table with porter-stemmed, code-tokenised queries.
 *  3. **Graph walk** — find entries that match by tag or file path, then
 *     traverse one hop across the `relationships` table.
 *  4. **Temporal search** — filter entries by `last_confirmed` when the
 *     query contains natural-language time references ("recent", "yesterday",
 *     "last week", etc.). Returns empty when no time signal is present,
 *     making it zero-cost for non-temporal queries.
 *
 * All functions return `RankedResult[]` sorted by descending score.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { SearchError } from "../utils/errors.js";
import { expandQuery } from "./query-expansion.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A search hit with its origin strategy and relevance score. */
export interface RankedResult {
  readonly id: string;
  readonly score: number;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Tokenisation helper
// ---------------------------------------------------------------------------

/**
 * Splits a mixed-casing code identifier into lowercase tokens suitable for
 * FTS5 query construction.
 *
 * Handles:
 * - camelCase → camel case
 * - snake_case → snake case
 * - dot.notation → dot notation
 * - Multiple whitespace tokens
 *
 * @param text - Raw query or identifier text.
 * @returns Space-joined lowercase tokens.
 */
export function codeTokenize(text: string): string {
  return text
    // Insert space before uppercase letters (camelCase → camel Case)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Replace underscores and dots with spaces
    .replace(/[_.]+/g, " ")
    // Collapse whitespace and lowercase everything
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Escapes FTS5 special characters so user-supplied queries don't break MATCH.
 *
 * Special characters in FTS5: `"`, `*`, `(`, `)`, `:`, `^`, `{`, `}`.
 * We replace them with spaces to preserve word boundaries.
 */
function escapeFts5(text: string): string {
  return text.replace(/["*():^{}]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Strategy 1: File-path search
// ---------------------------------------------------------------------------

interface EntryFileRow {
  entry_id: string;
}

/**
 * Finds entries that are associated with any of the given file paths.
 *
 * @param db - Open database connection.
 * @param files - List of file-system paths to search for.
 * @returns Ranked results ordered by descending score (match count).
 * @throws {SearchError} If the query fails.
 */
export function searchByFilePath(
  db: Database,
  files: string[],
): RankedResult[] {
  if (files.length === 0) {
    return [];
  }

  logger.debug("searchByFilePath", { fileCount: files.length });

  try {
    const placeholders = files.map(() => "?").join(", ");
    const sql = `
      SELECT entry_id, COUNT(*) AS match_count
      FROM   entry_files
      WHERE  file_path IN (${placeholders})
      GROUP  BY entry_id
      ORDER  BY match_count DESC
    `;

    const rows = db.query<{ entry_id: string; match_count: number }, string[]>(
      sql,
    ).all(...files);

    return rows.map((row) => ({
      id: row.entry_id,
      score: row.match_count,
      source: "file_path",
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SearchError(`searchByFilePath failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: BM25 / FTS5 search
// ---------------------------------------------------------------------------

interface FtsRow {
  id: string;
  rank: number;
}

/**
 * Searches the FTS5 index using a BM25-ranked query.
 *
 * The query string is pre-processed with `codeTokenize` to split
 * identifiers into individual terms.  An optional `type` filter restricts
 * results to a specific entry type.
 *
 * Scope filtering is applied when `developerId` is provided:
 *  - With a `developerId`: team, project, and the caller's personal entries.
 *  - Without a `developerId`: team and project entries only.
 *
 * BM25 rank from SQLite FTS5 is negative (more negative = better match), so
 * we negate it to produce a positive score where higher is better.
 *
 * @param db - Open database connection.
 * @param query - User-supplied search query.
 * @param type - Optional entry type filter ('error_pattern' | 'convention' |
 *   'decision' | 'learning').
 * @param developerId - Optional caller identity for personal entry access.
 * @returns Ranked results ordered by descending BM25 score.
 * @throws {SearchError} If the FTS query fails (e.g. malformed syntax).
 */
export function searchByBM25(
  db: Database,
  query: string,
  type?: string,
  developerId?: string,
): RankedResult[] {
  if (!query.trim()) {
    return [];
  }

  // Pipeline: tokenise the raw query first (camelCase split, lowercase),
  // then escape FTS5 special characters from user input, then expand with
  // synonym OR-groups. Expansion runs last so the parentheses it introduces
  // are not stripped by escapeFts5.
  const tokenised = expandQuery(escapeFts5(codeTokenize(query)));
  logger.debug("searchByBM25", { query, tokenised, type, developerId });

  if (!tokenised.trim()) {
    return [];
  }

  try {
    let sql: string;
    let params: SQLQueryBindings[];

    // Build the scope clause depending on whether we know who is asking.
    const scopeClause =
      developerId !== undefined
        ? `AND (e.scope IN ('team', 'project') OR (e.scope = 'personal' AND e.developer_id = ?))`
        : `AND e.scope IN ('team', 'project')`;

    if (type !== undefined) {
      if (developerId !== undefined) {
        sql = `
          SELECT e.id, f.rank
          FROM   entries_fts f
          JOIN   entries e ON e.rowid = f.rowid
          WHERE  entries_fts MATCH ?
            AND  e.type = ?
            AND  e.status = 'active'
            ${scopeClause}
          ORDER  BY f.rank
        `;
        params = [tokenised, type, developerId];
      } else {
        sql = `
          SELECT e.id, f.rank
          FROM   entries_fts f
          JOIN   entries e ON e.rowid = f.rowid
          WHERE  entries_fts MATCH ?
            AND  e.type = ?
            AND  e.status = 'active'
            ${scopeClause}
          ORDER  BY f.rank
        `;
        params = [tokenised, type];
      }
    } else {
      if (developerId !== undefined) {
        sql = `
          SELECT e.id, f.rank
          FROM   entries_fts f
          JOIN   entries e ON e.rowid = f.rowid
          WHERE  entries_fts MATCH ?
            AND  e.status = 'active'
            ${scopeClause}
          ORDER  BY f.rank
        `;
        params = [tokenised, developerId];
      } else {
        sql = `
          SELECT e.id, f.rank
          FROM   entries_fts f
          JOIN   entries e ON e.rowid = f.rowid
          WHERE  entries_fts MATCH ?
            AND  e.status = 'active'
            ${scopeClause}
          ORDER  BY f.rank
        `;
        params = [tokenised];
      }
    }

    const rows = db.query<FtsRow, SQLQueryBindings[]>(sql).all(...params);

    return rows.map((row) => ({
      id: row.id,
      // FTS5 rank is negative — negate so higher = better
      score: -row.rank,
      source: "bm25",
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SearchError(`searchByBM25 failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Graph walk
// ---------------------------------------------------------------------------

interface RelationshipRow {
  target_id: string;
}

/**
 * Graph-based search: finds seed entries that match `query` by file-path or
 * tag, then walks one hop outward along the `relationships` table to surface
 * related entries.
 *
 * Seeds receive a score of 2.0; one-hop neighbours receive 1.0.
 * Duplicate ids are deduplicated, keeping the highest score.
 *
 * @param db - Open database connection.
 * @param query - Search term used to locate seed entries.
 * @returns Ranked results ordered by descending score.
 * @throws {SearchError} If any of the underlying queries fail.
 */
export function searchByGraph(
  db: Database,
  query: string,
): RankedResult[] {
  if (!query.trim()) {
    return [];
  }

  logger.debug("searchByGraph", { query });

  try {
    const likePattern = `%${query.toLowerCase()}%`;

    // Find seed entries by file-path or tag substring match
    const seedSql = `
      SELECT DISTINCT e.id AS entry_id
      FROM   entries e
      LEFT   JOIN entry_files ef ON ef.entry_id = e.id
      LEFT   JOIN entry_tags  et ON et.entry_id = e.id
      WHERE  e.status = 'active'
        AND  (
               LOWER(COALESCE(ef.file_path, '')) LIKE ?
            OR LOWER(COALESCE(et.tag, ''))       LIKE ?
             )
    `;

    const seedRows = db
      .query<EntryFileRow, [string, string]>(seedSql)
      .all(likePattern, likePattern);

    if (seedRows.length === 0) {
      return [];
    }

    const seedIds = seedRows.map((r) => r.entry_id);

    // Accumulate results: seeds score 2.0, neighbours score 1.0
    const scoreMap = new Map<string, number>();
    for (const id of seedIds) {
      scoreMap.set(id, 2.0);
    }

    // Walk one hop outward
    const placeholders = seedIds.map(() => "?").join(", ");
    const hopSql = `
      SELECT target_id
      FROM   relationships
      WHERE  source_id IN (${placeholders})
    `;

    const hopRows = db
      .query<RelationshipRow, string[]>(hopSql)
      .all(...seedIds);

    for (const row of hopRows) {
      if (!scoreMap.has(row.target_id)) {
        scoreMap.set(row.target_id, 1.0);
      }
    }

    // Build sorted result array
    return Array.from(scoreMap.entries())
      .map(([id, score]) => ({ id, score, source: "graph" }))
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SearchError(`searchByGraph failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Strategy 4: Temporal search
// ---------------------------------------------------------------------------
// The canonical implementation lives in ./temporal.ts as a standalone
// module. We re-export the public symbols here so existing call sites
// (retrieval-eval harness, future MCP tools) can import from a single
// search entry point if they prefer.

export { parseTimeReference, searchByTemporal } from "./temporal.js";

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * Fuses multiple ranked lists into a single unified ranking using Reciprocal
 * Rank Fusion (RRF).
 *
 * RRF score for a document `d` across lists: Σ 1 / (k + rank(d, list))
 * where rank is 1-indexed.  Documents not present in a list are ignored for
 * that list.
 *
 * @param rankedLists - Array of ranked result lists to fuse.
 * @param k - RRF smoothing constant (default 60 — the standard value from
 *   the original 2009 paper).
 * @returns A single list of `RankedResult` with `source = "rrf"`, sorted by
 *   descending fused score.
 */
export function reciprocalRankFusion(
  rankedLists: RankedResult[][],
  k: number = 60,
): RankedResult[] {
  if (rankedLists.length === 0) {
    return [];
  }

  const fusedScores = new Map<string, number>();

  for (const list of rankedLists) {
    list.forEach((result, index) => {
      const rank = index + 1; // 1-indexed
      const contribution = 1 / (k + rank);
      const current = fusedScores.get(result.id) ?? 0;
      fusedScores.set(result.id, current + contribution);
    });
  }

  return Array.from(fusedScores.entries())
    .map(([id, score]) => ({ id, score, source: "rrf" }))
    .sort((a, b) => b.score - a.score);
}
