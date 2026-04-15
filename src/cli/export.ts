/**
 * gyst export — DB-first markdown exporter.
 * Reads all active entries from DB and writes markdown files to wikiDir.
 * Updates entries.markdown_path in DB after writing.
 * Skips entries whose markdown_path already points to an existing file.
 */

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { writeEntry } from "../compiler/writer.js";
import { logger } from "../utils/logger.js";
import type { Config } from "../utils/config.js";

/** Row shape returned by the active-entries query. */
interface ActiveEntryRow {
  id: string;
  type: "error_pattern" | "convention" | "decision" | "learning" | "ghost_knowledge";
  title: string;
  content: string;
  confidence: number;
  source_count: number;
  source_tool: string | null;
  created_at: string;
  last_confirmed: string;
  scope: string;
  markdown_path: string | null;
}

/** Result returned by {@link exportToMarkdown}. */
export interface ExportResult {
  exported: number;
  skipped: number;
}

/**
 * Exports all active entries to markdown files in config.wikiDir.
 * Skips entries that already have an existing markdown file on disk.
 * Updates entries.markdown_path in DB for each file written.
 *
 * @param db      - Open bun:sqlite Database instance.
 * @param config  - Must contain `wikiDir` — the output directory for markdown files.
 * @returns       Counts of exported and skipped entries.
 */
export async function exportToMarkdown(
  db: Database,
  config: Pick<Config, "wikiDir">,
): Promise<ExportResult> {
  const rows = db
    .query<ActiveEntryRow, []>(
      `SELECT id, type, title, content, confidence, source_count, source_tool,
              created_at, last_confirmed, scope, markdown_path
       FROM entries
       WHERE status = 'active'
       ORDER BY created_at ASC`,
    )
    .all();

  let exported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.markdown_path && existsSync(row.markdown_path)) {
      skipped += 1;
      continue;
    }

    try {
      const tags = db
        .query<{ tag: string }, [string]>(
          "SELECT tag FROM entry_tags WHERE entry_id = ?",
          [row.id],
        )
        .all()
        .map((r) => r.tag);

      const files = db
        .query<{ file_path: string }, [string]>(
          "SELECT file_path FROM entry_files WHERE entry_id = ?",
          [row.id],
        )
        .all()
        .map((r) => r.file_path);

      const validScope = z
        .enum(["team", "personal", "project"])
        .catch("team")
        .parse(row.scope);

      const mdPath = writeEntry(
        {
          id: row.id,
          type: row.type,
          title: row.title,
          content: row.content,
          files,
          tags,
          confidence: row.confidence,
          sourceCount: row.source_count,
          sourceTool: row.source_tool ?? undefined,
          createdAt: row.created_at,
          lastConfirmed: row.last_confirmed,
          scope: validScope,
        },
        config.wikiDir,
      );

      db.transaction(() => {
        db.run("UPDATE entries SET markdown_path = ? WHERE id = ?", [mdPath, row.id]);
      })();
      exported += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("exportToMarkdown: failed to write entry", { id: row.id, error: msg });
    }
  }

  logger.info("exportToMarkdown complete", { exported, skipped });
  return { exported, skipped };
}
