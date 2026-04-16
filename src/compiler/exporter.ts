/**
 * Wiki Exporter.
 *
 * Handles the bulk export of database entries to the on-disk markdown wiki.
 * Respects the `suppressExport` metadata flag to prevent cluttering the 
 * file system with structural AST data while still keeping it in the DB 
 * for dashboard visualization and recall context.
 */

import type { Database } from "bun:sqlite";
import { writeEntry } from "./writer.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

interface ExportRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  source_count: number;
  last_confirmed: string;
  metadata?: string;
  scope: string;
}

/**
 * Syncs the database entries to the markdown wiki.
 */
export function exportWiki(db: Database, wikiDir?: string): number {
  const dir = wikiDir ?? loadConfig().wikiDir;
  
  const rows = db.query<ExportRow, []>(
    `SELECT id, type, title, content, confidence, source_count, last_confirmed, metadata, scope 
     FROM entries 
     WHERE status = 'active'`
  ).all();

  let exported = 0;

  for (const row of rows) {
    // Check for suppression flag
    if (row.metadata) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.suppressExport) continue;
      } catch {
        // invalid JSON
      }
    }

    try {
      // Map DB row to KnowledgeEntry expected by writeEntry
      // Note: we fetch tags/files separately for a clean map
      const tags = db.query<{tag: string}, [string]>("SELECT tag FROM entry_tags WHERE entry_id = ?", [row.id]).all().map(t => t.tag);
      const files = db.query<{file_path: string}, [string]>("SELECT file_path FROM entry_files WHERE entry_id = ?", [row.id]).all().map(f => f.file_path);

      writeEntry({
        id: row.id,
        type: row.type as any,
        title: row.title,
        content: row.content,
        confidence: row.confidence,
        sourceCount: row.source_count,
        lastConfirmed: row.last_confirmed,
        tags,
        files,
        status: 'active',
        scope: row.scope as any
      }, dir);
      
      exported++;
    } catch (err) {
      logger.error("exporter: failed to write entry", { id: row.id, error: String(err) });
    }
  }

  return exported;
}
