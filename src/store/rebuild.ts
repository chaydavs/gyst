/**
 * Rebuild the Gyst SQLite index from markdown source files.
 *
 * Markdown files in `gyst-wiki/` are the source of truth. The SQLite database
 * is a derived, fully-regenerable index. This module implements that
 * regeneration: it walks the wiki directory, parses every `.md` file (except
 * `index.md`), and upserts the results into the database.
 *
 * Key invariant: running `rebuildFromMarkdown` twice in a row must leave the
 * database in exactly the same state as running it once (idempotent).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import matter from "gray-matter";
import type { Database } from "bun:sqlite";
import { initDatabase } from "./database.js";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/errors.js";
import type { Config } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Statistics returned after a rebuild run. */
export interface RebuildStats {
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: number;
}

/** Validated data parsed out of a single wiki markdown file. */
interface ParsedEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly files: readonly string[];
  readonly tags: readonly string[];
  readonly errorSignature?: string;
  readonly confidence: number;
  readonly sourceCount: number;
  readonly sourceTool?: string;
  readonly lastConfirmed?: string;
  readonly status: string;
  /** The relative path within wikiDir (used as file_path in the DB). */
  readonly relPath: string;
}

// ---------------------------------------------------------------------------
// Valid entry types (mirrors DB CHECK constraint)
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set([
  "error_pattern",
  "convention",
  "decision",
  "learning",
]);

const VALID_STATUSES = new Set(["active", "stale", "conflicted", "archived"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuilds the SQLite index by scanning all markdown files in `config.wikiDir`.
 *
 * Processing steps:
 * 1. Open / create the database.
 * 2. Walk `wikiDir` recursively for `.md` files (skip `index.md`).
 * 3. Parse each file's YAML frontmatter + body with `gray-matter`.
 * 4. Validate required fields; skip files that fail validation (logged as errors).
 * 5. Upsert each entry: INSERT if new, UPDATE if already present.
 * 6. Return {@link RebuildStats}.
 *
 * The FTS5 triggers on the `entries` table keep the full-text index in sync
 * automatically — no separate indexing call is needed.
 *
 * @param config - Gyst configuration (provides `wikiDir` and `dbPath`).
 * @returns Statistics describing what happened during the rebuild.
 * @throws {DatabaseError} If the database cannot be opened.
 */
export async function rebuildFromMarkdown(config: Config): Promise<RebuildStats> {
  logger.info("rebuildFromMarkdown: starting", {
    wikiDir: config.wikiDir,
    dbPath: config.dbPath,
  });

  const db = initDatabase(config.dbPath);

  try {
    const mdFiles = walkMarkdownFiles(config.wikiDir);
    logger.debug("rebuildFromMarkdown: found markdown files", {
      count: mdFiles.length,
    });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const absPath of mdFiles) {
      const parsed = parseMarkdownEntry(absPath, config.wikiDir);
      if (parsed === null) {
        skipped += 1;
        continue;
      }

      try {
        const action = upsertEntry(db, parsed);
        if (action === "created") {
          created += 1;
        } else {
          updated += 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("rebuildFromMarkdown: failed to upsert entry", {
          path: absPath,
          error: msg,
        });
        errors += 1;
      }
    }

    const total = mdFiles.length;
    const stats: RebuildStats = {
      total,
      created,
      updated,
      skipped,
      errors,
    };

    logger.info("rebuildFromMarkdown: complete", {
      total: stats.total,
      created: stats.created,
      updated: stats.updated,
      skipped: stats.skipped,
      errors: stats.errors,
    });
    return stats;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walks `dir` recursively and returns the absolute paths of every `.md` file,
 * excluding any file named exactly `index.md`.
 *
 * @param dir - Absolute or relative path to the wiki directory.
 * @returns Sorted list of absolute `.md` file paths.
 */
function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory does not exist yet — return empty list rather than throwing.
    logger.debug("walkMarkdownFiles: directory not found", { dir });
    return [];
  }

  for (const name of entries) {
    const absPath = join(dir, name);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      logger.warn("walkMarkdownFiles: could not stat path", { absPath });
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...walkMarkdownFiles(absPath));
    } else if (
      stat.isFile() &&
      name.endsWith(".md") &&
      name !== "index.md"
    ) {
      results.push(absPath);
    }
  }

  return results.sort();
}

/**
 * Parses a single markdown file into a {@link ParsedEntry}.
 *
 * Returns `null` (and logs a warning) when:
 * - The file cannot be read.
 * - The frontmatter is missing required fields (`type`, `confidence`).
 * - `type` is not one of the four canonical values.
 *
 * The entry `id` is sourced from frontmatter `id` if present; otherwise it is
 * derived deterministically from the file's path relative to `wikiDir`.
 *
 * @param filePath - Absolute path to the markdown file.
 * @param wikiDir  - Absolute path to the wiki root (used for relative paths
 *   and ID generation).
 * @returns A {@link ParsedEntry} or `null` if the file should be skipped.
 */
function parseMarkdownEntry(filePath: string, wikiDir: string): ParsedEntry | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("parseMarkdownEntry: cannot read file", { filePath, error: msg });
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("parseMarkdownEntry: malformed frontmatter", {
      filePath,
      error: msg,
    });
    return null;
  }

  const fm = parsed.data as Record<string, unknown>;

  // --- Required: type ---
  const type = fm["type"];
  if (typeof type !== "string" || !VALID_TYPES.has(type)) {
    logger.warn("parseMarkdownEntry: missing or invalid 'type' in frontmatter", {
      filePath,
      type,
    });
    return null;
  }

  // --- Required: confidence ---
  const rawConfidence = fm["confidence"];
  const confidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : parseFloat(String(rawConfidence ?? ""));
  if (isNaN(confidence) || confidence < 0 || confidence > 1) {
    logger.warn(
      "parseMarkdownEntry: missing or invalid 'confidence' in frontmatter",
      { filePath, rawConfidence },
    );
    return null;
  }

  // --- Title: first h1 heading in body, or stem of filename ---
  const relPath = relative(wikiDir, filePath);
  const titleFromBody = extractFirstH1(parsed.content);
  const titleFromFile = basename(filePath, ".md").replace(/-/g, " ");
  const title = (titleFromBody ?? titleFromFile).trim();

  if (title.length === 0) {
    logger.warn("parseMarkdownEntry: cannot determine title", { filePath });
    return null;
  }

  // --- id: frontmatter > deterministic slug from relPath ---
  const id =
    typeof fm["id"] === "string" && fm["id"].trim().length > 0
      ? fm["id"].trim()
      : relPathToId(relPath);

  // --- Optional fields ---
  const rawTags = fm["tags"];
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : [];

  const rawAffects = fm["affects"];
  const files: string[] = Array.isArray(rawAffects)
    ? rawAffects.filter((f): f is string => typeof f === "string")
    : [];

  const sourceCount =
    typeof fm["sources"] === "number" ? fm["sources"] : 1;

  const lastConfirmed =
    typeof fm["last_confirmed"] === "string" ? fm["last_confirmed"] : undefined;

  const errorSignature =
    typeof fm["error_signature"] === "string" ? fm["error_signature"] : undefined;

  const sourceTool =
    typeof fm["source_tool"] === "string" ? fm["source_tool"] : undefined;

  const rawStatus = fm["status"];
  const status =
    typeof rawStatus === "string" && VALID_STATUSES.has(rawStatus)
      ? rawStatus
      : "active";

  // Content: everything after the frontmatter (strip the h1 heading line)
  const bodyContent = stripFirstH1(parsed.content).trim();

  return {
    id,
    type,
    title,
    content: bodyContent.length > 0 ? bodyContent : title,
    files,
    tags,
    errorSignature,
    confidence,
    sourceCount,
    sourceTool,
    lastConfirmed,
    status,
    relPath,
  };
}

/**
 * Upserts a parsed entry into the database using INSERT ... ON CONFLICT DO UPDATE
 * semantics so the operation is fully idempotent.
 *
 * Associated `entry_files` and `entry_tags` rows are replaced in the same
 * transaction.
 *
 * @param db    - Open database connection.
 * @param entry - Validated parsed entry.
 * @returns `"created"` if the row was new, `"updated"` if it already existed.
 * @throws {DatabaseError} If the transaction fails.
 */
function upsertEntry(db: Database, entry: ParsedEntry): "created" | "updated" {
  // Check existence before upsert so we can return the correct action.
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM entries WHERE id = ?")
    .get(entry.id);

  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      db.run(
        `INSERT INTO entries
          (id, type, title, content, file_path, error_signature,
           confidence, source_count, source_tool, created_at, last_confirmed, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type            = excluded.type,
           title           = excluded.title,
           content         = excluded.content,
           file_path       = excluded.file_path,
           error_signature = excluded.error_signature,
           confidence      = excluded.confidence,
           source_count    = excluded.source_count,
           source_tool     = excluded.source_tool,
           last_confirmed  = excluded.last_confirmed,
           status          = excluded.status`,
        [
          entry.id,
          entry.type,
          entry.title,
          entry.content,
          entry.files[0] ?? entry.relPath,
          entry.errorSignature ?? null,
          entry.confidence,
          entry.sourceCount,
          entry.sourceTool ?? "rebuild",
          now,
          entry.lastConfirmed ?? now,
          entry.status,
        ],
      );

      // Replace file associations
      db.run("DELETE FROM entry_files WHERE entry_id = ?", [entry.id]);
      for (const filePath of entry.files) {
        db.run(
          "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
          [entry.id, filePath],
        );
      }
      // Always record the wiki file itself
      db.run(
        "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
        [entry.id, entry.relPath],
      );

      // Replace tag associations
      db.run("DELETE FROM entry_tags WHERE entry_id = ?", [entry.id]);
      for (const tag of entry.tags) {
        db.run(
          "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
          [entry.id, tag],
        );
      }
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`upsertEntry failed for id=${entry.id}: ${msg}`);
  }

  logger.debug("upsertEntry: done", {
    id: entry.id,
    action: existing !== null ? "updated" : "created",
  });

  return existing !== null ? "updated" : "created";
}

/**
 * Extracts the text content of the first `# Heading` line in a markdown body.
 *
 * @param body - Raw markdown body (after gray-matter strips frontmatter).
 * @returns The heading text, or `null` if no `#` heading is found.
 */
function extractFirstH1(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

/**
 * Removes the first `# Heading` line from a markdown body.
 *
 * @param body - Raw markdown body.
 * @returns Body with the first h1 removed.
 */
function stripFirstH1(body: string): string {
  return body.replace(/^#\s+.+\n?/m, "");
}

/**
 * Converts a relative wiki path (e.g. `"error_pattern/my-entry.md"`) into a
 * stable identifier string (e.g. `"error_pattern/my-entry"`).
 *
 * @param relPath - Path relative to `wikiDir`.
 * @returns A deterministic string id.
 */
function relPathToId(relPath: string): string {
  return relPath.replace(/\.md$/, "").replace(/\\/g, "/");
}
