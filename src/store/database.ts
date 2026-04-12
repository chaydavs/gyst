/**
 * SQLite database initialisation for Gyst.
 *
 * Uses `bun:sqlite` which is fully synchronous — no async/await needed.
 * WAL mode and foreign-key enforcement are enabled on every connection.
 *
 * Schema overview:
 *   entries          – core knowledge records
 *   entry_files      – many-to-many: entries ↔ source file paths
 *   entry_tags       – many-to-many: entries ↔ free-form tags
 *   relationships    – directed edges between entries
 *   sources          – provenance: who/when/what contributed each entry
 *   entries_fts      – FTS5 virtual table over entries (porter stemmer)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Custom SQLite binary (required for extension loading)
// ---------------------------------------------------------------------------
// Bun's bundled SQLite does NOT allow loading extensions, which is needed
// for sqlite-vec. We point at a system libsqlite3 that supports extensions.
// This is done lazily on first Database construction, process-wide.
//
// Probe order:
//   1. GYST_SQLITE_PATH environment override
//   2. Homebrew on macOS (/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib)
//   3. Homebrew Intel (/usr/local/opt/sqlite/lib/libsqlite3.dylib)
//   4. Ubuntu / Debian (/usr/lib/x86_64-linux-gnu/libsqlite3.so.0)
//   5. Ubuntu ARM64 (/usr/lib/aarch64-linux-gnu/libsqlite3.so.0)
//
// If none found, fall back to Bun's bundled SQLite — extensions won't
// work (semantic search will be disabled), but every other feature
// keeps running.

const SQLITE_PROBE_PATHS = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/libsqlite3.so.0",
] as const;

let customSqliteApplied = false;

function applyCustomSqliteOnce(): boolean {
  if (customSqliteApplied) {
    return true;
  }
  const overridePath = process.env["GYST_SQLITE_PATH"];
  const candidates = overridePath !== undefined
    ? [overridePath, ...SQLITE_PROBE_PATHS]
    : [...SQLITE_PROBE_PATHS];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        Database.setCustomSQLite(candidate);
        customSqliteApplied = true;
        logger.info("Custom SQLite loaded", { path: candidate });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("setCustomSQLite failed", { path: candidate, error: msg });
      }
    }
  }

  logger.warn(
    "No system libsqlite3 found — falling back to bundled Bun SQLite. " +
      "Semantic search will be disabled.",
  );
  return false;
}

/**
 * Returns true if the process is using a system SQLite that supports
 * extension loading. Callers that need vec0 should check this before
 * attempting initVectorStore.
 */
export function canLoadExtensions(): boolean {
  return customSqliteApplied;
}

// ---------------------------------------------------------------------------
// DDL statements executed at startup
// ---------------------------------------------------------------------------

/** Pragmas applied to every new connection */
const PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA synchronous = NORMAL;",
] as const;

/** Individual DDL statements — one per CREATE TABLE / INDEX / TRIGGER */
const SCHEMA_STATEMENTS: readonly string[] = [
  // ----- tables -----
  `CREATE TABLE IF NOT EXISTS entries (
    id               TEXT    NOT NULL PRIMARY KEY,
    type             TEXT    NOT NULL CHECK (type IN ('error_pattern','convention','decision','learning','ghost_knowledge')),
    title            TEXT    NOT NULL,
    content          TEXT    NOT NULL DEFAULT '',
    file_path        TEXT,
    error_signature  TEXT,
    confidence       REAL    NOT NULL DEFAULT 0.5,
    source_count     INTEGER NOT NULL DEFAULT 1,
    source_tool      TEXT,
    created_at       TEXT    NOT NULL,
    last_confirmed   TEXT    NOT NULL,
    superseded_by    TEXT,
    status           TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','stale','conflicted','archived','consolidated')),
    scope            TEXT    NOT NULL DEFAULT 'team'
                            CHECK (scope IN ('personal','team','project')),
    developer_id     TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS entry_files (
    entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    PRIMARY KEY (entry_id, file_path)
  )`,

  `CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS relationships (
    source_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN (
                 'related_to','supersedes','contradicts','depends_on','caused_by'
               )),
    UNIQUE (source_id, target_id, type)
  )`,

  `CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    entry_id      TEXT    NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    developer_id  TEXT,
    tool          TEXT,
    session_id    TEXT,
    git_commit    TEXT,
    timestamp     TEXT    NOT NULL
  )`,

  // ----- FTS5 virtual table -----
  `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
    USING fts5(
      title,
      content,
      error_signature,
      content    = 'entries',
      content_rowid = 'rowid',
      tokenize   = 'porter unicode61'
    )`,

  // ----- FTS5 sync triggers -----
  `CREATE TRIGGER IF NOT EXISTS entries_fts_ai
    AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, title, content, error_signature)
      VALUES (new.rowid, new.title, new.content, new.error_signature);
    END`,

  `CREATE TRIGGER IF NOT EXISTS entries_fts_ad
    AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, content, error_signature)
      VALUES ('delete', old.rowid, old.title, old.content, old.error_signature);
    END`,

  `CREATE TRIGGER IF NOT EXISTS entries_fts_au
    AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, content, error_signature)
      VALUES ('delete', old.rowid, old.title, old.content, old.error_signature);
      INSERT INTO entries_fts(rowid, title, content, error_signature)
      VALUES (new.rowid, new.title, new.content, new.error_signature);
    END`,

  `CREATE TABLE IF NOT EXISTS feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id     TEXT    NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    developer_id TEXT,
    helpful      INTEGER NOT NULL CHECK(helpful IN (0, 1)),
    note         TEXT,
    timestamp    TEXT    NOT NULL DEFAULT (datetime('now'))
  )`,

  "CREATE INDEX IF NOT EXISTS idx_feedback_entry     ON feedback(entry_id)",
  "CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback(timestamp)",

  // ----- indexes -----
  "CREATE INDEX IF NOT EXISTS idx_entries_type        ON entries(type)",
  "CREATE INDEX IF NOT EXISTS idx_entries_status      ON entries(status)",
  "CREATE INDEX IF NOT EXISTS idx_entries_confidence  ON entries(confidence)",
  `CREATE INDEX IF NOT EXISTS idx_entries_error_sig   ON entries(error_signature)
    WHERE error_signature IS NOT NULL`,
  "CREATE INDEX IF NOT EXISTS idx_entry_files_path    ON entry_files(file_path)",
  "CREATE INDEX IF NOT EXISTS idx_entry_tags_tag      ON entry_tags(tag)",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the Gyst SQLite database at `path`, applies the schema,
 * and enables WAL mode and foreign-key enforcement.
 *
 * This function is **synchronous** — `bun:sqlite` does not expose async APIs.
 *
 * @param path - File-system path for the SQLite database.
 *   Defaults to `"gyst-wiki/.wiki.db"`.
 * @returns An open `bun:sqlite` `Database` instance ready for use.
 * @throws {DatabaseError} If the database cannot be opened or the schema
 *   cannot be applied.
 */
export function initDatabase(path: string = "gyst-wiki/.wiki.db"): Database {
  logger.info("Initialising database", { path });

  // Try to switch to a system SQLite that supports extension loading.
  // Safe to call repeatedly — internal guard makes it a one-shot.
  applyCustomSqliteOnce();

  // Ensure parent directory exists (bun:sqlite won't create it)
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to create database directory: ${msg}`);
  }

  let db: Database;
  try {
    db = new Database(path, { create: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to open database at ${path}: ${msg}`);
  }

  try {
    // Apply connection pragmas
    for (const pragma of PRAGMAS) {
      db.run(pragma);
    }

    // Apply schema idempotently
    for (const statement of SCHEMA_STATEMENTS) {
      db.run(statement);
    }
  } catch (err) {
    db.close();
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to initialise schema: ${msg}`);
  }

  logger.info("Database ready", { path });
  return db;
}

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

/** Shape accepted by insertEntry — mirrors KnowledgeEntry from the compiler. */
export interface EntryRow {
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
  readonly createdAt?: string;
  readonly lastConfirmed?: string;
  readonly status?: string;
  readonly scope?: "personal" | "team" | "project";
  readonly developerId?: string;
}

/**
 * Inserts a knowledge entry, its files, tags, and a source row inside a
 * single transaction.
 *
 * The FTS5 index is kept in sync via the `entries_fts_ai` trigger — no
 * separate indexing call is needed.
 */
export function insertEntry(db: Database, entry: EntryRow): void {
  const now = new Date().toISOString();

  db.transaction(() => {
    db.run(
      `INSERT INTO entries
        (id, type, title, content, file_path, error_signature,
         confidence, source_count, source_tool, created_at, last_confirmed, status,
         scope, developer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.type,
        entry.title,
        entry.content,
        entry.files[0] ?? null,
        entry.errorSignature ?? null,
        entry.confidence,
        entry.sourceCount,
        entry.sourceTool ?? null,
        entry.createdAt ?? now,
        entry.lastConfirmed ?? now,
        entry.status ?? "active",
        entry.scope ?? "team",
        entry.developerId ?? null,
      ],
    );

    for (const filePath of entry.files) {
      db.run(
        "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
        [entry.id, filePath],
      );
    }

    for (const tag of entry.tags) {
      db.run(
        "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
        [entry.id, tag],
      );
    }

    db.run(
      `INSERT INTO sources (entry_id, tool, timestamp) VALUES (?, ?, ?)`,
      [entry.id, entry.sourceTool ?? "manual", now],
    );
  })();

  logger.debug("Entry inserted", { id: entry.id, type: entry.type });
}
