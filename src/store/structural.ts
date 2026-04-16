/**
 * Adjacent-index helpers for the structural graph (graphify).
 *
 * Structural nodes live in a separate table (`structural_nodes`) precisely so
 * that deterministic AST data never pollutes curated retrieval, FTS, or
 * confidence scoring. These helpers compose structural data into consumer
 * responses AFTER the curated RRF ranking has settled — never as part of it.
 *
 * Design rule: callers pass the files they care about (either direct file
 * context from the query, or files derived from top curated results). We
 * return matching structural nodes as an ordered sidecar. If the result is
 * empty, callers should drop the adjacent section entirely.
 */

import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

export interface StructuralAdjacent {
  readonly id: string;
  readonly label: string;
  readonly filePath: string;
  readonly fileType: string | null;
  readonly sourceLocation: string | null;
}

interface StructuralRow {
  id: string;
  label: string;
  file_path: string;
  file_type: string | null;
  source_location: string | null;
}

/**
 * Returns structural nodes whose `file_path` matches any of the supplied
 * file paths, ordered by `last_seen DESC`, capped at `limit`.
 *
 * Intended as a post-retrieval sidecar — callers should surface the output
 * alongside (not interleaved with) their ranked curated results so the
 * structural layer stays clearly adjacent.
 */
export function getStructuralForFiles(
  db: Database,
  filePaths: readonly string[],
  limit = 5,
): StructuralAdjacent[] {
  if (filePaths.length === 0 || limit <= 0) return [];

  // Deduplicate — callers often pass overlapping file lists (query context +
  // curated-result files).
  const unique = Array.from(new Set(filePaths));
  const placeholders = unique.map(() => "?").join(", ");

  const rows = db
    .query<StructuralRow, (string | number)[]>(
      `SELECT id, label, file_path, file_type, source_location
       FROM structural_nodes
       WHERE file_path IN (${placeholders})
       ORDER BY last_seen DESC
       LIMIT ?`,
    )
    .all(...unique, limit);

  logger.debug("getStructuralForFiles", {
    requestedFiles: unique.length,
    matched: rows.length,
  });

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    filePath: r.file_path,
    fileType: r.file_type,
    sourceLocation: r.source_location,
  }));
}

/**
 * Resolves top-ranked curated entry IDs to their associated file paths
 * (via `entry_files`) and returns matching structural nodes.
 *
 * Union-merges with any caller-supplied file context so explicit file hints
 * from the query take priority alongside derived paths.
 */
export function getStructuralForEntries(
  db: Database,
  entryIds: readonly string[],
  explicitFiles: readonly string[] = [],
  limit = 5,
): StructuralAdjacent[] {
  const files = new Set<string>(explicitFiles);

  if (entryIds.length > 0) {
    const placeholders = entryIds.map(() => "?").join(", ");
    const rows = db
      .query<{ file_path: string }, string[]>(
        `SELECT DISTINCT file_path FROM entry_files
         WHERE entry_id IN (${placeholders})`,
      )
      .all(...(entryIds as string[]));
    for (const r of rows) files.add(r.file_path);
  }

  return getStructuralForFiles(db, Array.from(files), limit);
}
