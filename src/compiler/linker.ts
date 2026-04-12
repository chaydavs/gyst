/**
 * Relationship linker for the Gyst compiler layer.
 *
 * Builds directed edges between knowledge entries in the `relationships` table.
 * Related entries are discovered by three criteria (evaluated in order):
 *   1. Shared affected files
 *   2. Shared tags
 *   3. Matching error-pattern type (for `error_pattern` entries only)
 */

import type { Database } from "bun:sqlite";
import type { KnowledgeEntry } from "./extract.js";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface RelatedRow {
  id: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Finds entries in the database that are related to `entry` by shared files,
 * shared tags, or matching error type.
 *
 * Only `active` entries are considered. The entry itself is excluded from
 * results.
 *
 * @param db - Open database connection.
 * @param entry - The entry whose relationships should be resolved.
 * @returns Array of `{ id, type }` objects for each related entry found.
 * @throws {DatabaseError} On database access failure.
 */
export function findRelatedEntries(
  db: Database,
  entry: KnowledgeEntry,
): Array<{ id: string; type: string }> {
  const relatedIds = new Set<string>();
  const related: RelatedRow[] = [];

  try {
    // 1. Shared affected files
    if (entry.files.length > 0) {
      const placeholders = entry.files.map(() => "?").join(", ");
      const fileRows = db
        .query<RelatedRow, string[]>(
          `SELECT DISTINCT e.id, e.type
           FROM entries e
           JOIN entry_files ef ON ef.entry_id = e.id
           WHERE ef.file_path IN (${placeholders})
             AND e.id != ?
             AND e.status = 'active'`,
        )
        .all(...entry.files, entry.id);

      for (const row of fileRows) {
        if (!relatedIds.has(row.id)) {
          relatedIds.add(row.id);
          related.push(row);
        }
      }
    }

    // 2. Shared tags
    if (entry.tags.length > 0) {
      const placeholders = entry.tags.map(() => "?").join(", ");
      const tagRows = db
        .query<RelatedRow, string[]>(
          `SELECT DISTINCT e.id, e.type
           FROM entries e
           JOIN entry_tags et ON et.entry_id = e.id
           WHERE et.tag IN (${placeholders})
             AND e.id != ?
             AND e.status = 'active'`,
        )
        .all(...entry.tags, entry.id);

      for (const row of tagRows) {
        if (!relatedIds.has(row.id)) {
          relatedIds.add(row.id);
          related.push(row);
        }
      }
    }

    // 3. Matching error signature (for error_pattern entries)
    if (entry.type === "error_pattern" && entry.errorSignature !== undefined) {
      const sigRows = db
        .query<RelatedRow, [string, string]>(
          `SELECT id, type
           FROM entries
           WHERE type = 'error_pattern'
             AND id != ?
             AND status = 'active'
             AND error_signature = ?`,
        )
        .all(entry.id, entry.errorSignature);

      for (const row of sigRows) {
        if (!relatedIds.has(row.id)) {
          relatedIds.add(row.id);
          related.push(row);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to find related entries for ${entry.id}: ${msg}`);
  }

  logger.debug("Related entries found", {
    entryId: entry.id,
    count: related.length,
  });

  return related.map(({ id, type }) => ({ id, type }));
}

/**
 * Inserts a directed relationship edge between two entries.
 *
 * If the relationship already exists the insert is silently ignored
 * (uses `INSERT OR IGNORE`).
 *
 * @param db - Open database connection.
 * @param sourceId - The entry that is the source of the relationship.
 * @param targetId - The entry that is the target of the relationship.
 * @param type - Relationship type; must be one of the values enforced by the
 *   database CHECK constraint:
 *   `"related_to" | "supersedes" | "contradicts" | "depends_on" | "caused_by"`.
 * @throws {DatabaseError} On database write failure.
 */
export function createRelationship(
  db: Database,
  sourceId: string,
  targetId: string,
  type: string,
): void {
  try {
    db.run(
      `INSERT OR IGNORE INTO relationships (source_id, target_id, type)
       VALUES (?, ?, ?)`,
      [sourceId, targetId, type],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(
      `Failed to create relationship ${sourceId} -> ${targetId} (${type}): ${msg}`,
    );
  }

  logger.debug("Relationship created", { sourceId, targetId, type });
}
