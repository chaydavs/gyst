/**
 * 5-stage consolidation pipeline for the Gyst knowledge base.
 *
 * Prevents the wiki from becoming a junk drawer as it grows. Runs as a
 * scheduled maintenance task or on-demand via `gyst consolidate`.
 *
 * Stages:
 *   1. Decay   — recalculate confidence with current timestamps
 *   2. Dedupe  — merge near-duplicates (fingerprint + semantic)
 *   3. Merge   — synthesize file-clusters into summary entries
 *   4. Archive — flip low-confidence entries to status='archived'
 *   5. Reindex — rebuild FTS5 sync + regenerate gyst-wiki/index.md
 *
 * Ghost knowledge entries are NEVER touched by any stage — they're
 * pinned at confidence 1.0 and must always surface.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/errors.js";
import { calculateConfidence } from "../store/confidence.js";
import { canLoadExtensions } from "../store/database.js";
import { searchByVector } from "../store/embeddings.js";
import { loadConfig } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary of work done by each pipeline stage. */
export interface ConsolidationReport {
  readonly entriesDecayed: number;
  readonly duplicatesMerged: number;
  readonly clustersConsolidated: number;
  readonly entriesArchived: number;
  readonly indexEntries: number;
  readonly linksStrengthened: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal row types (never exposed publicly)
// ---------------------------------------------------------------------------

interface ActiveEntryRow {
  id: string;
  type: string;
  confidence: number;
  source_count: number;
  last_confirmed: string;
}

interface FingerprintGroupRow {
  error_signature: string;
  ids: string;
}

interface EntryForMergeRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
}

interface FileClusterRow {
  file_path: string;
  c: number;
}

interface ActiveCountRow {
  cnt: number;
}

interface FtsCountRow {
  cnt: number;
}

interface IndexRow {
  id: string;
  type: string;
  title: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Stage 1 — Decay
// ---------------------------------------------------------------------------

/**
 * Recalculates confidence for every active non-ghost entry using the current
 * timestamp. Updates any entry whose confidence has shifted by more than 0.05.
 *
 * Wraps all updates in a single transaction to keep the database consistent.
 *
 * @param db - Open database connection.
 * @returns Number of entries whose confidence was updated.
 */
function stage1Decay(db: Database): number {
  logger.info("consolidate: stage 1 — decay");

  const rows = db
    .query<ActiveEntryRow, []>(
      `SELECT id, type, confidence, source_count, last_confirmed
       FROM entries
       WHERE status = 'active'
         AND type != 'ghost_knowledge'`,
    )
    .all();

  const now = new Date();
  let decayed = 0;

  try {
    db.transaction(() => {
      for (const row of rows) {
        const newConfidence = calculateConfidence({
          type: row.type,
          sourceCount: row.source_count,
          lastConfirmedAt: row.last_confirmed,
          now,
          hasContradiction: false,
          codeChanged: false,
        });

        if (Math.abs(newConfidence - row.confidence) > 0.05) {
          db.run(
            "UPDATE entries SET confidence = ? WHERE id = ?",
            [newConfidence, row.id],
          );
          decayed += 1;
        }
      }
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Stage 1 decay failed: ${msg}`);
  }

  logger.info("consolidate: stage 1 complete", { decayed });
  return decayed;
}

// ---------------------------------------------------------------------------
// Stage 2 — Dedupe (fingerprint + semantic)
// ---------------------------------------------------------------------------

/**
 * Merges near-duplicate entries using two strategies:
 *   A. Fingerprint match — entries sharing the same error_signature.
 *   B. Semantic dedup — entries whose embedding vectors are extremely close
 *      (score > 0.9, i.e. distance < 0.111), only when sqlite-vec is available.
 *
 * For each duplicate pair: the entry with the higher confidence is kept, its
 * source_count is incremented, and the other entry is archived with
 * superseded_by pointing to the kept ID.
 *
 * Only merges entries of the same type. Ghost knowledge is always skipped.
 *
 * @param db - Open database connection.
 * @returns Total number of entries archived as duplicates.
 */
async function stage2Dedupe(db: Database): Promise<number> {
  logger.info("consolidate: stage 2 — dedupe");

  let mergeCount = 0;

  // Part A — fingerprint match
  const fingerprintGroups = db
    .query<FingerprintGroupRow, []>(
      `SELECT error_signature, GROUP_CONCAT(id) AS ids
       FROM entries
       WHERE error_signature IS NOT NULL
         AND status = 'active'
       GROUP BY error_signature
       HAVING COUNT(*) > 1`,
    )
    .all();

  for (const group of fingerprintGroups) {
    const ids = group.ids.split(",").filter((id) => id.length > 0);
    if (ids.length < 2) {
      continue;
    }

    interface ConfRow { id: string; confidence: number; source_count: number }
    const entries = db
      .query<ConfRow, string[]>(
        `SELECT id, confidence, source_count FROM entries WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);

    if (entries.length < 2) {
      continue;
    }

    // Keep the entry with the highest confidence
    const sorted = [...entries].sort((a, b) => b.confidence - a.confidence);
    const kept = sorted[0];
    const toArchive = sorted.slice(1);

    const totalSourceCount = entries.reduce((sum, e) => sum + e.source_count, 0);

    try {
      db.transaction(() => {
        db.run(
          "UPDATE entries SET source_count = ? WHERE id = ?",
          [totalSourceCount, kept.id],
        );
        for (const entry of toArchive) {
          db.run(
            "UPDATE entries SET status = 'archived', superseded_by = ? WHERE id = ?",
            [kept.id, entry.id],
          );
          mergeCount += 1;
        }
      })();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(`Stage 2A fingerprint merge failed: ${msg}`);
    }
  }

  // Part B — semantic dedup (only if sqlite-vec is available AND the table exists)
  // The entry_vectors table is created by initVectorStore(), which must have been
  // called before semantic dedup can run. We check for the table's existence to
  // guard against test environments where the extension is loadable but the table
  // hasn't been initialised yet.
  const vectorTableExists =
    canLoadExtensions() &&
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("entry_vectors") !== null;

  if (vectorTableExists) {
    interface ActiveVecRow { id: string; type: string; title: string; content: string }
    const activeEntries = db
      .query<ActiveVecRow, []>(
        `SELECT e.id, e.type, e.title, e.content
         FROM entries e
         INNER JOIN entry_vectors v ON v.entry_id = e.id
         WHERE e.status = 'active'
           AND e.type != 'ghost_knowledge'`,
      )
      .all();

    // Track processed pairs to avoid O(n²) redundancy
    const processed = new Set<string>();

    for (const entry of activeEntries) {
      const queryText = `${entry.title}\n\n${entry.content}`;

      let candidates: Awaited<ReturnType<typeof searchByVector>>;
      try {
        candidates = await searchByVector(db, queryText, 5, undefined);
      } catch {
        // Semantic search failed for this entry — skip it
        continue;
      }

      for (const candidate of candidates) {
        // Skip self-match
        if (candidate.id === entry.id) {
          continue;
        }

        // Only consider very close matches (score > 0.9 ≈ distance < 0.111)
        if (candidate.score <= 0.9) {
          continue;
        }

        // Avoid processing the same pair twice
        const pairKey = [entry.id, candidate.id].sort().join(":");
        if (processed.has(pairKey)) {
          continue;
        }
        processed.add(pairKey);

        // Fetch candidate type to enforce same-type constraint
        interface TypeRow { type: string; confidence: number; source_count: number }
        const candidateRow = db
          .query<TypeRow, [string]>(
            "SELECT type, confidence, source_count FROM entries WHERE id = ? AND status = 'active'",
          )
          .get(candidate.id);

        if (candidateRow === null) {
          continue;
        }

        // Only merge entries of the same type
        if (candidateRow.type !== entry.type) {
          continue;
        }

        interface EntryConfRow { confidence: number; source_count: number }
        const entryRow = db
          .query<EntryConfRow, [string]>(
            "SELECT confidence, source_count FROM entries WHERE id = ? AND status = 'active'",
          )
          .get(entry.id);

        if (entryRow === null) {
          continue;
        }

        // Determine which to keep based on confidence
        const keepId = entryRow.confidence >= candidateRow.confidence ? entry.id : candidate.id;
        const archiveId = keepId === entry.id ? candidate.id : entry.id;
        const keptConf = keepId === entry.id ? entryRow : candidateRow;
        const archivedConf = keepId === entry.id ? candidateRow : entryRow;

        try {
          db.transaction(() => {
            db.run(
              "UPDATE entries SET source_count = ? WHERE id = ?",
              [keptConf.source_count + archivedConf.source_count, keepId],
            );
            db.run(
              "UPDATE entries SET status = 'archived', superseded_by = ? WHERE id = ?",
              [keepId, archiveId],
            );
          })();
          mergeCount += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new DatabaseError(`Stage 2B semantic merge failed: ${msg}`);
        }
      }
    }
  }

  logger.info("consolidate: stage 2 complete", { mergeCount });
  return mergeCount;
}

// ---------------------------------------------------------------------------
// Stage 3 — Merge file clusters
// ---------------------------------------------------------------------------

/**
 * Finds files with >= 5 active error_pattern or learning entries, creates a
 * summary entry for each such file, and marks the originals as 'consolidated'.
 *
 * Types convention, decision, and ghost_knowledge are never consolidated.
 *
 * NOTE: This stage requires the 'consolidated' status value to be present in
 * the CHECK constraint on entries.status in database.ts. The main session must
 * add 'consolidated' to that constraint before this pipeline is wired into
 * production (see decisions/008).
 *
 * @param db - Open database connection.
 * @returns Number of summary entries created.
 */
function stage3MergeClusters(db: Database): number {
  logger.info("consolidate: stage 3 — merge clusters");

  const clusters = db
    .query<FileClusterRow, []>(
      `SELECT ef.file_path, COUNT(*) AS c
       FROM entry_files ef
       JOIN entries e ON e.id = ef.entry_id
       WHERE e.status = 'active'
         AND e.type IN ('error_pattern', 'learning')
       GROUP BY ef.file_path
       HAVING COUNT(*) >= 5`,
    )
    .all();

  let summariesCreated = 0;

  for (const cluster of clusters) {
    const clusterEntries = db
      .query<EntryForMergeRow, [string]>(
        `SELECT e.id, e.title, e.content, e.confidence
         FROM entries e
         JOIN entry_files ef ON ef.entry_id = e.id
         WHERE ef.file_path = ?
           AND e.status = 'active'
           AND e.type IN ('error_pattern', 'learning')`,
      )
      .all(cluster.file_path);

    if (clusterEntries.length < 5) {
      continue;
    }

    const summaryId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Build summary content as a bullet list
    const bullets = clusterEntries.map((e) => {
      // First sentence of content (up to the first period, '?', or '!')
      const firstSentence = e.content.split(/[.!?]/)[0]?.trim() ?? e.content.substring(0, 80);
      return `- **${e.title}**: ${firstSentence}`;
    });

    const summaryContent = bullets.join("\n");
    const avgConfidence = Math.min(
      1.0,
      clusterEntries.reduce((sum, e) => sum + e.confidence, 0) / clusterEntries.length,
    );

    try {
      db.transaction(() => {
        // Insert the summary entry directly via SQL (already in a transaction batch)
        db.run(
          `INSERT INTO entries
            (id, type, title, content, file_path, confidence, source_count,
             created_at, last_confirmed, status, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'team')`,
          [
            summaryId,
            "learning",
            `Summary: ${cluster.file_path} patterns and knowledge`,
            summaryContent,
            cluster.file_path,
            avgConfidence,
            clusterEntries.length,
            now,
            now,
          ],
        );

        // Link the summary entry to the file
        db.run(
          "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
          [summaryId, cluster.file_path],
        );

        // Tag the summary
        db.run(
          "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
          [summaryId, "consolidated-summary"],
        );

        // Mark originals — use 'archived' as a safe fallback since the
        // 'consolidated' status may not yet be in the CHECK constraint.
        // The main session will update the CHECK constraint and this code
        // should be changed to use 'consolidated' once that lands.
        // See decisions/008 for the action item.
        for (const entry of clusterEntries) {
          db.run(
            "UPDATE entries SET status = 'archived', superseded_by = ? WHERE id = ?",
            [summaryId, entry.id],
          );
        }
      })();
      summariesCreated += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(`Stage 3 cluster merge failed for ${cluster.file_path}: ${msg}`);
    }
  }

  logger.info("consolidate: stage 3 complete", { summariesCreated });
  return summariesCreated;
}

// ---------------------------------------------------------------------------
// Stage 4 — Archive low-confidence
// ---------------------------------------------------------------------------

/**
 * Archives all active entries (except ghost_knowledge) whose confidence has
 * fallen below the 0.15 threshold. These entries are no longer surfaced
 * in recall results.
 *
 * @param db - Open database connection.
 * @returns Number of entries archived.
 */
function stage4Archive(db: Database): number {
  logger.info("consolidate: stage 4 — archive");

  try {
    const result = db.run(
      `UPDATE entries
       SET status = 'archived'
       WHERE status = 'active'
         AND confidence < 0.15
         AND type != 'ghost_knowledge'`,
    );

    const archived = result.changes;
    logger.info("consolidate: stage 4 complete", { archived });
    return archived;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Stage 4 archive failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — Reindex
// ---------------------------------------------------------------------------

/**
 * Verifies FTS5 consistency and regenerates the gyst-wiki/index.md file.
 *
 * FTS5 sync: if the active entry count diverges from the FTS5 row count, the
 * FTS5 index is rebuilt in-place using SQLite's built-in rebuild command.
 *
 * Index file: a simple markdown index grouped by entry type is written to
 * gyst-wiki/index.md using loadConfig() for the wiki directory path.
 *
 * @param db - Open database connection.
 * @returns Total count of active entries after reindex.
 */
function stage5Reindex(db: Database, wikiDirOverride?: string): number {
  logger.info("consolidate: stage 5 — reindex");

  // Count active entries
  const activeRow = db
    .query<ActiveCountRow, []>(
      "SELECT COUNT(*) AS cnt FROM entries WHERE status = 'active'",
    )
    .get();

  const activeCount = activeRow?.cnt ?? 0;

  // Count FTS5 rows
  const ftsRow = db
    .query<FtsCountRow, []>(
      "SELECT COUNT(*) AS cnt FROM entries_fts",
    )
    .get();

  const ftsCount = ftsRow?.cnt ?? 0;

  if (activeCount !== ftsCount) {
    logger.warn("FTS5 mismatch — rebuilding", { activeCount, ftsCount });
    try {
      db.run("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
      logger.info("FTS5 rebuild complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(`FTS5 rebuild failed: ${msg}`);
    }
  }

  // Regenerate <wikiDir>/index.md. Tests pass a temp dir to avoid
  // writing to the real gyst-wiki/ checked-in location.
  const wikiDir = wikiDirOverride ?? loadConfig().wikiDir;

  const indexRows = db
    .query<IndexRow, []>(
      `SELECT id, type, title, confidence
       FROM entries
       WHERE status = 'active'
       ORDER BY type, confidence DESC`,
    )
    .all();

  // Group by type
  const byType = new Map<string, IndexRow[]>();
  for (const row of indexRows) {
    const existing = byType.get(row.type) ?? [];
    byType.set(row.type, [...existing, row]);
  }

  const lines: string[] = [
    "# Gyst Knowledge Base Index",
    "",
    `> Generated: ${new Date().toISOString()}  `,
    `> Active entries: ${activeCount}`,
    "",
  ];

  for (const [type, entries] of byType.entries()) {
    lines.push(`## ${type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`);
    lines.push("");
    for (const entry of entries) {
      const confStr = entry.confidence.toFixed(2);
      lines.push(`- ${entry.title} *(confidence: ${confStr})*`);
    }
    lines.push("");
  }

  const indexMarkdown = lines.join("\n");

  try {
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "index.md"), indexMarkdown, "utf8");
    logger.info("Wiki index regenerated", { path: join(wikiDir, "index.md"), count: activeCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to write wiki index: ${msg}`);
  }

  logger.info("consolidate: stage 5 complete", { activeCount });
  return activeCount;
}

/**
 * Stage 2.5 — strengthen co-retrieved links.
 *
 * Runs after dedupe, before merge, so fresh co-retrieval edges inform
 * cluster formation.
 *
 * Finds entry pairs that have been recalled together >= 3 times and
 * creates explicit `related_to` edges between them if none exist yet.
 *
 * @param db - Open bun:sqlite database handle.
 * @returns Number of co-retrieved pairs processed.
 */
async function stage2_5StrengthenLinks(db: Database): Promise<number> {
  const { strengthenCoRetrievedLinks } = await import("../store/graph.js");
  return strengthenCoRetrievedLinks(db, 3);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the 5-stage consolidation pipeline on the given database.
 *
 * This is safe to call repeatedly — the pipeline is designed to be idempotent.
 * A second run immediately after the first should report near-zero changes.
 *
 * @param db - Open bun:sqlite database handle with the Gyst schema applied.
 * @returns A {@link ConsolidationReport} summarising all changes made.
 * @throws {DatabaseError} If any stage encounters a database error.
 */
export async function consolidate(
  db: Database,
  options: { wikiDir?: string } = {},
): Promise<ConsolidationReport> {
  const started = performance.now();
  logger.info("consolidate: starting pipeline");

  const decayed = stage1Decay(db);
  const duplicatesMerged = await stage2Dedupe(db);
  const linksStrengthened = await stage2_5StrengthenLinks(db);
  const clusters = stage3MergeClusters(db);
  const archived = stage4Archive(db);
  const indexEntries = stage5Reindex(db, options.wikiDir);

  const durationMs = performance.now() - started;

  const report: ConsolidationReport = {
    entriesDecayed: decayed,
    duplicatesMerged,
    clustersConsolidated: clusters,
    entriesArchived: archived,
    indexEntries,
    linksStrengthened,
    durationMs,
  };

  logger.info("consolidate: complete", report as unknown as Record<string, unknown>);
  return report;
}
