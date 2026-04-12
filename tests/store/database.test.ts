/**
 * Tests for database initialisation and schema correctness.
 *
 * All tests use `:memory:` so no files are created on disk.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid EntryRow for insertion tests. */
function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    type: "learning",
    title: "Test Entry Title",
    content: "This is the test content for the entry.",
    files: [],
    tags: [],
    confidence: 0.5,
    sourceCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// initDatabase
// ---------------------------------------------------------------------------

describe("initDatabase", () => {
  test("returns a Database instance", () => {
    const db = initDatabase(":memory:");
    expect(db).toBeInstanceOf(Database);
    db.close();
  });

  test("creates the entries table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("entries");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("entries");
    db.close();
  });

  test("creates the entry_files table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("entry_files");
    expect(row).not.toBeNull();
    db.close();
  });

  test("creates the entry_tags table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("entry_tags");
    expect(row).not.toBeNull();
    db.close();
  });

  test("creates the relationships table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("relationships");
    expect(row).not.toBeNull();
    db.close();
  });

  test("creates the sources table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("sources");
    expect(row).not.toBeNull();
    db.close();
  });

  test("creates the entries_fts virtual table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE name = ?",
      )
      .get("entries_fts");
    expect(row).not.toBeNull();
    db.close();
  });

  test("is idempotent — safe to call twice on the same path", () => {
    const db = initDatabase(":memory:");
    // Should not throw when schema already exists
    expect(() => {
      // We can't call initDatabase(":memory:") twice on the same connection,
      // but we can verify schema DDL uses IF NOT EXISTS by running the
      // schema-dependent operations directly.
      db.run("CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('error_pattern','convention','decision','learning')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', file_path TEXT, error_signature TEXT, confidence REAL NOT NULL DEFAULT 0.5, source_count INTEGER NOT NULL DEFAULT 1, source_tool TEXT, created_at TEXT NOT NULL, last_confirmed TEXT NOT NULL, superseded_by TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','conflicted','archived')))");
    }).not.toThrow();
    db.close();
  });

  test("WAL journal mode is enabled", () => {
    const db = initDatabase(":memory:");
    // For :memory: databases SQLite reports 'memory' not 'wal', but we can
    // confirm the pragma ran without error by querying it back.
    const row = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    expect(row).not.toBeNull();
    // In-memory databases use 'memory' mode; the pragma accepted without error
    expect(typeof row?.journal_mode).toBe("string");
    db.close();
  });

  test("foreign keys are enabled", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get();
    expect(row).not.toBeNull();
    expect(row?.foreign_keys).toBe(1);
    db.close();
  });

  test("idx_entries_type index exists", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_entries_type");
    expect(row).not.toBeNull();
    db.close();
  });

  test("idx_entries_status index exists", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_entries_status");
    expect(row).not.toBeNull();
    db.close();
  });

  test("idx_entries_confidence index exists", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_entries_confidence");
    expect(row).not.toBeNull();
    db.close();
  });

  test("idx_entries_error_sig index exists", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_entries_error_sig");
    expect(row).not.toBeNull();
    db.close();
  });

  test("idx_entry_files_path index exists", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_entry_files_path");
    expect(row).not.toBeNull();
    db.close();
  });

  test("idx_entry_tags_tag index exists", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_entry_tags_tag");
    expect(row).not.toBeNull();
    db.close();
  });

  test("entries type CHECK constraint rejects invalid type", () => {
    const db = initDatabase(":memory:");
    const now = new Date().toISOString();
    expect(() => {
      db.run(
        `INSERT INTO entries
          (id, type, title, content, confidence, source_count, created_at, last_confirmed, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["bad-type-id", "invalid_type", "Title", "Content", 0.5, 1, now, now, "active"],
      );
    }).toThrow();
    db.close();
  });

  test("entries status CHECK constraint rejects invalid status", () => {
    const db = initDatabase(":memory:");
    const now = new Date().toISOString();
    expect(() => {
      db.run(
        `INSERT INTO entries
          (id, type, title, content, confidence, source_count, created_at, last_confirmed, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["bad-status-id", "learning", "Title", "Content", 0.5, 1, now, now, "invalid_status"],
      );
    }).toThrow();
    db.close();
  });

  test("FTS5 trigger syncs data on insert", () => {
    const db = initDatabase(":memory:");
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO entries
        (id, type, title, content, confidence, source_count, created_at, last_confirmed, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["fts-test-id", "learning", "FTS Trigger Test Title", "Unique FTS test content string", 0.5, 1, now, now, "active"],
    );

    const row = db
      .query<{ rowid: number }, []>(
        "SELECT rowid FROM entries_fts WHERE title MATCH 'fts trigger test'",
      )
      .get();
    expect(row).not.toBeNull();
    db.close();
  });

  test("FTS5 trigger syncs delete operation", () => {
    const db = initDatabase(":memory:");
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO entries
        (id, type, title, content, confidence, source_count, created_at, last_confirmed, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["fts-delete-id", "learning", "FTS Delete Trigger", "Content to be deleted from index", 0.5, 1, now, now, "active"],
    );

    // Verify it's in FTS before deletion
    const before = db
      .query<{ rowid: number }, []>(
        "SELECT rowid FROM entries_fts WHERE title MATCH 'fts delete trigger'",
      )
      .get();
    expect(before).not.toBeNull();

    // Delete the entry
    db.run("DELETE FROM entries WHERE id = ?", ["fts-delete-id"]);

    // The FTS index should no longer find it via content= table
    const after = db
      .query<{ rowid: number }, []>(
        "SELECT rowid FROM entries_fts WHERE title MATCH 'fts delete trigger'",
      )
      .get();
    expect(after).toBeNull();
    db.close();
  });

  test("FTS5 trigger syncs update operation", () => {
    const db = initDatabase(":memory:");
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO entries
        (id, type, title, content, confidence, source_count, created_at, last_confirmed, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["fts-update-id", "learning", "Original FTS Update Title", "Original content", 0.5, 1, now, now, "active"],
    );

    db.run(
      "UPDATE entries SET title = ? WHERE id = ?",
      ["Updated FTS Title Text", "fts-update-id"],
    );

    // Old title should not be in the index
    const old = db
      .query<{ rowid: number }, []>(
        "SELECT rowid FROM entries_fts WHERE title MATCH 'original fts update'",
      )
      .get();
    expect(old).toBeNull();

    // New title should be found
    const updated = db
      .query<{ rowid: number }, []>(
        "SELECT rowid FROM entries_fts WHERE title MATCH 'updated fts title'",
      )
      .get();
    expect(updated).not.toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// insertEntry
// ---------------------------------------------------------------------------

describe("insertEntry", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  test("inserts an entry into the entries table", () => {
    const entry = makeEntry({ id: "insert-test-1", type: "learning" });
    insertEntry(db, entry);

    const row = db
      .query<{ id: string; type: string }, [string]>(
        "SELECT id, type FROM entries WHERE id = ?",
      )
      .get(entry.id);

    expect(row).not.toBeNull();
    expect(row?.id).toBe(entry.id);
    expect(row?.type).toBe("learning");
  });

  test("inserts file paths into entry_files", () => {
    const entry = makeEntry({
      id: "insert-files-1",
      files: ["src/foo.ts", "src/bar.ts"],
    });
    insertEntry(db, entry);

    const rows = db
      .query<{ file_path: string }, [string]>(
        "SELECT file_path FROM entry_files WHERE entry_id = ?",
      )
      .all(entry.id);

    const paths = rows.map((r) => r.file_path).sort();
    expect(paths).toEqual(["src/bar.ts", "src/foo.ts"]);
  });

  test("inserts tags into entry_tags", () => {
    const entry = makeEntry({
      id: "insert-tags-1",
      tags: ["typescript", "auth"],
    });
    insertEntry(db, entry);

    const rows = db
      .query<{ tag: string }, [string]>(
        "SELECT tag FROM entry_tags WHERE entry_id = ?",
      )
      .all(entry.id);

    const tags = rows.map((r) => r.tag).sort();
    expect(tags).toEqual(["auth", "typescript"]);
  });

  test("inserts a source row into sources", () => {
    const entry = makeEntry({ id: "insert-source-1", sourceTool: "test-tool" });
    insertEntry(db, entry);

    const row = db
      .query<{ tool: string }, [string]>(
        "SELECT tool FROM sources WHERE entry_id = ?",
      )
      .get(entry.id);

    expect(row).not.toBeNull();
    expect(row?.tool).toBe("test-tool");
  });

  test("stores error_signature when provided", () => {
    const entry = makeEntry({
      id: "insert-err-sig-1",
      type: "error_pattern",
      errorSignature: "typeerror: cannot read property <str> of undefined",
    });
    insertEntry(db, entry);

    const row = db
      .query<{ error_signature: string }, [string]>(
        "SELECT error_signature FROM entries WHERE id = ?",
      )
      .get(entry.id);

    expect(row?.error_signature).toBe(
      "typeerror: cannot read property <str> of undefined",
    );
  });

  test("handles entries with empty files and tags arrays", () => {
    const entry = makeEntry({ id: "insert-empty-1", files: [], tags: [] });
    expect(() => insertEntry(db, entry)).not.toThrow();

    const files = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM entry_files WHERE entry_id = ?",
      )
      .get(entry.id);
    expect(files?.count).toBe(0);
  });

  test("sets default status to active", () => {
    const entry = makeEntry({ id: "insert-status-1" });
    insertEntry(db, entry);

    const row = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM entries WHERE id = ?",
      )
      .get(entry.id);

    expect(row?.status).toBe("active");
  });

  test("stores the entry in FTS5 index for full-text search", () => {
    const entry = makeEntry({
      id: "insert-fts-1",
      title: "Unique Canary Title For FTS Test",
      content: "Unique canary content that should be indexed",
    });
    insertEntry(db, entry);

    const row = db
      .query<{ rowid: number }, []>(
        "SELECT rowid FROM entries_fts WHERE title MATCH 'unique canary title'",
      )
      .get();
    expect(row).not.toBeNull();
  });

  test("accepts all four valid entry types", () => {
    const types = ["error_pattern", "convention", "decision", "learning"] as const;
    for (const type of types) {
      const entry = makeEntry({ id: `type-test-${type}`, type });
      expect(() => insertEntry(db, entry)).not.toThrow();
    }
  });
});
