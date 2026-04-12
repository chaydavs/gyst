/**
 * Deduplication logic for the Gyst compiler layer.
 *
 * Two strategies are used to detect duplicates:
 *   1. **Exact fingerprint match** — two error-pattern entries with the same
 *      SHA-256-derived fingerprint are considered identical.
 *   2. **Jaccard similarity** — entries whose combined set of tags and affected
 *      files overlaps above the threshold are considered duplicates.
 *
 * When a duplicate is found, {@link mergeEntries} creates a new merged entry
 * (immutable — neither input is mutated).
 */

import type { Database } from "bun:sqlite";
import type { KnowledgeEntry } from "./extract.js";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum Jaccard similarity (tags ∪ files) to classify entries as duplicates. */
const JACCARD_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Computes the Jaccard similarity of two string sets.
 *
 * @param a - First set.
 * @param b - Second set.
 * @returns A value in [0, 1]. Returns 0 when both sets are empty.
 */
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  const intersection = new Set<string>();
  for (const item of a) {
    if (b.has(item)) {
      intersection.add(item);
    }
  }

  const union = new Set<string>([...a, ...b]);
  return intersection.size / union.size;
}

/**
 * Loads the tags and files associated with a given entry from the database.
 *
 * @param db - Open database connection.
 * @param entryId - Entry to look up.
 * @returns Combined set of tags and file paths.
 */
function loadTagsAndFiles(db: Database, entryId: string): Set<string> {
  try {
    const tags = db
      .query<{ tag: string }, [string]>(
        "SELECT tag FROM entry_tags WHERE entry_id = ?",
      )
      .all(entryId)
      .map((r) => r.tag);

    const files = db
      .query<{ file_path: string }, [string]>(
        "SELECT file_path FROM entry_files WHERE entry_id = ?",
      )
      .all(entryId)
      .map((r) => r.file_path);

    return new Set<string>([...tags, ...files]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to load tags/files for entry ${entryId}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Row type returned by the candidate queries
// ---------------------------------------------------------------------------

interface EntryIdRow {
  id: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Searches the database for an existing entry that duplicates `entry`.
 *
 * Lookup order:
 * 1. Exact fingerprint match (fastest — uses an index).
 * 2. Jaccard similarity over the union of tags and affected files.
 *
 * @param db - Open database connection.
 * @param entry - The newly extracted entry to check against.
 * @returns The `id` of a matching existing entry, or `null` if none found.
 * @throws {DatabaseError} On database access failure.
 */
export function findDuplicate(db: Database, entry: KnowledgeEntry): string | null {
  // 1. Fingerprint match
  if (entry.fingerprint !== undefined) {
    try {
      const row = db
        .query<EntryIdRow, [string]>(
          "SELECT id FROM entries WHERE error_signature = ? AND status != 'archived' LIMIT 1",
        )
        .get(entry.fingerprint);

      if (row !== null) {
        logger.info("Duplicate found by fingerprint", {
          newId: entry.id,
          existingId: row.id,
        });
        return row.id;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(`Fingerprint lookup failed: ${msg}`);
    }
  }

  // 2. Jaccard similarity over tags + files
  const incomingSet = new Set<string>([...entry.tags, ...entry.files]);
  if (incomingSet.size === 0) {
    return null;
  }

  let candidates: EntryIdRow[];
  try {
    candidates = db
      .query<EntryIdRow, [string, string]>(
        `SELECT DISTINCT e.id
         FROM entries e
         LEFT JOIN entry_tags  et ON et.entry_id = e.id
         LEFT JOIN entry_files ef ON ef.entry_id = e.id
         WHERE e.type = ?
           AND e.status != 'archived'
           AND e.id != ?`,
      )
      .all(entry.type, entry.id) as EntryIdRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Candidate query failed: ${msg}`);
  }

  for (const candidate of candidates) {
    const existingSet = loadTagsAndFiles(db, candidate.id);
    const similarity = jaccardSimilarity(incomingSet, existingSet);

    if (similarity >= JACCARD_THRESHOLD) {
      logger.info("Duplicate found by Jaccard similarity", {
        newId: entry.id,
        existingId: candidate.id,
        similarity,
      });
      return candidate.id;
    }
  }

  return null;
}

/**
 * Merges `incoming` into `existing`, producing a **new** {@link KnowledgeEntry}.
 *
 * Merge rules:
 * - `content` is taken from whichever entry has the more recent `lastConfirmed`.
 * - `sourceCount` is incremented by the incoming entry's count.
 * - `files` and `tags` are unioned (duplicates removed).
 * - `confidence` is the maximum of the two values.
 * - All other fields are kept from `existing`.
 *
 * Neither `existing` nor `incoming` is mutated.
 *
 * @param existing - The persisted entry already in the database.
 * @param incoming - The newly extracted entry.
 * @returns A merged {@link KnowledgeEntry} based on `existing`'s id.
 */
export function mergeEntries(
  existing: KnowledgeEntry,
  incoming: KnowledgeEntry,
): KnowledgeEntry {
  const existingTs = existing.lastConfirmed ?? existing.createdAt ?? "";
  const incomingTs = incoming.lastConfirmed ?? incoming.createdAt ?? "";

  const newerContent = incomingTs > existingTs ? incoming.content : existing.content;

  const mergedFiles = Array.from(new Set([...existing.files, ...incoming.files]));
  const mergedTags = Array.from(new Set([...existing.tags, ...incoming.tags]));

  const merged: KnowledgeEntry = {
    ...existing,
    content: newerContent,
    sourceCount: existing.sourceCount + incoming.sourceCount,
    files: mergedFiles,
    tags: mergedTags,
    confidence: Math.max(existing.confidence, incoming.confidence),
    lastConfirmed: incomingTs > existingTs ? incomingTs : existingTs,
  };

  logger.info("Entries merged", {
    existingId: existing.id,
    incomingId: incoming.id,
    newSourceCount: merged.sourceCount,
  });

  return merged;
}
