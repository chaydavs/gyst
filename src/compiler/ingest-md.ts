/**
 * MD file ingester for gyst.
 *
 * Scans a project directory for markdown files (CLAUDE.md, specs, ADRs, etc.)
 * and ingests them into the knowledge base as `md_doc` entries.
 *
 * Ingestion is idempotent: each file is SHA-256 hashed and compared against
 * the stored `source_file_hash`. Unchanged files are skipped; changed files
 * trigger an in-place update; new files are inserted.
 */

import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IngestResult {
  created?: boolean;
  updated?: boolean;
  skipped?: boolean;
  entryId?: string;
}

export interface IngestSummary {
  created: number;
  updated: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Directory exclusion list
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "gyst-wiki",
  ".turbo",
  ".next",
  "build",
  "coverage",
  "__pycache__",
]);

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Recursively collects all `.md` files under `projectDir`, skipping
 * excluded directories (node_modules, .git, dist, gyst-wiki, etc.).
 *
 * Returns absolute paths.
 */
export function scanMdFiles(projectDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      logger.warn("scanMdFiles: cannot read directory", { dir, error: String(err) });
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry) && !entry.startsWith(".")) {
          walk(fullPath);
        }
      } else if (stat.isFile() && entry.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  walk(projectDir);
  return results;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Returns a 16-character SHA-256 hex digest of the given string.
 * Sufficient for change detection; not used for security purposes.
 */
function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

/**
 * Derives a human-readable title from the file, in priority order:
 * 1. `title` field in YAML frontmatter
 * 2. First `# H1` heading in the markdown body
 * 3. Filename without the `.md` extension
 */
function extractTitle(
  relPath: string,
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  if (typeof frontmatter["title"] === "string" && frontmatter["title"].trim()) {
    return frontmatter["title"].trim();
  }
  const h1Match = /^#\s+(.+)$/m.exec(content);
  if (h1Match) return h1Match[1]!.trim();
  return relPath.split("/").pop()?.replace(/\.md$/, "") ?? relPath;
}

// ---------------------------------------------------------------------------
// Section summary (stored alongside excerpt for better BM25 hits)
// ---------------------------------------------------------------------------

/**
 * Extracts the first 8 headings (H1-H3) as a dot-separated summary string.
 * This keeps the BM25 section signal even when the full content is truncated.
 */
function extractSectionSummary(content: string): string {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    if (/^#{1,3}\s/.test(line)) {
      headings.push(line.replace(/^#+\s/, "").trim());
    }
    if (headings.length >= 8) break;
  }
  return headings.join(" . ");
}

// ---------------------------------------------------------------------------
// Core ingestion
// ---------------------------------------------------------------------------

/**
 * Ingests a single markdown file into the database.
 *
 * - Reads and hashes the file.
 * - If an existing `md_doc` entry with the same `file_path` exists and the
 *   hash matches, returns `{ skipped: true }`.
 * - If the hash differs, updates the existing entry.
 * - If no entry exists, inserts a new one.
 *
 * All writes are wrapped in a transaction.
 */
export function ingestMdFile(
  db: Database,
  filePath: string,
  projectDir: string,
): IngestResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    logger.warn("ingestMdFile: cannot read file", { filePath, error: String(err) });
    return { skipped: true };
  }

  const hash = computeHash(raw);
  const relPath = relative(projectDir, filePath);

  // Check for existing entry by relative path
  const existing = db
    .query<{ id: string; source_file_hash: string | null }, [string]>(
      "SELECT id, source_file_hash FROM entries WHERE type='md_doc' AND file_path=? LIMIT 1",
    )
    .get(relPath);

  if (existing && existing.source_file_hash === hash) {
    return { skipped: true, entryId: existing.id };
  }

  // Parse frontmatter and markdown body
  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  const markdownBody = parsed.content;

  const title = extractTitle(relPath, frontmatter, markdownBody);
  const sections = extractSectionSummary(markdownBody);

  // Build stored content: section TOC + truncated excerpt (code blocks condensed)
  const excerpt = markdownBody
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 2000);
  const content = sections ? `${sections}\n\n${excerpt}` : excerpt;

  const tags: string[] = Array.isArray(frontmatter["tags"])
    ? (frontmatter["tags"] as string[])
    : [];
  const now = new Date().toISOString();

  if (existing) {
    // Update in place - preserve the original entry id
    db.transaction(() => {
      db.run(
        "UPDATE entries SET title=?, content=?, source_file_hash=?, last_confirmed=? WHERE id=?",
        [title, content, hash, now, existing.id],
      );
      db.run("DELETE FROM entry_tags WHERE entry_id=?", [existing.id]);
      for (const tag of tags) {
        db.run(
          "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
          [existing.id, tag],
        );
      }
    })();
    logger.info("ingestMdFile: updated", { relPath, id: existing.id });
    return { updated: true, entryId: existing.id };
  }

  // Insert new entry
  const id = `md_doc_${hash}`;
  db.transaction(() => {
    db.run(
      `INSERT INTO entries
         (id, type, title, content, file_path, confidence, source_count,
          created_at, last_confirmed, status, scope, source_file_hash)
       VALUES (?, 'md_doc', ?, ?, ?, 0.9, 1, ?, ?, 'active', 'team', ?)`,
      [id, title, content, relPath, now, now, hash],
    );
    for (const tag of tags) {
      db.run(
        "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
        [id, tag],
      );
    }
    db.run(
      "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
      [id, relPath],
    );
  })();
  logger.info("ingestMdFile: created", { relPath, id });
  return { created: true, entryId: id };
}

// ---------------------------------------------------------------------------
// Batch ingestion
// ---------------------------------------------------------------------------

/**
 * Scans `projectDir` for all markdown files and ingests each one.
 * Returns a summary of how many entries were created, updated, or skipped.
 */
export function ingestAllMdFiles(db: Database, projectDir: string): IngestSummary {
  const files = scanMdFiles(projectDir);
  const summary: IngestSummary = { created: 0, updated: 0, skipped: 0 };

  for (const filePath of files) {
    const result = ingestMdFile(db, filePath, projectDir);
    if (result.created) summary.created++;
    else if (result.updated) summary.updated++;
    else summary.skipped++;
  }

  logger.info("ingestAllMdFiles: complete", { projectDir, ...summary });
  return summary;
}
