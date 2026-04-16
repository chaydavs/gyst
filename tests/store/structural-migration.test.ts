import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";

describe("structural index migration", () => {
  test("moves pre-existing type='structural' rows from entries to structural_nodes", () => {
    // Simulate an old DB that had graphify data mixed into entries.
    const db = new Database(":memory:");
    // Create the old schema shape manually (includes 'structural' in CHECK).
    db.run(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('error_pattern','convention','decision','learning','ghost_knowledge','structural')),
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      error_signature TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_count INTEGER NOT NULL DEFAULT 1,
      source_tool TEXT,
      created_at TEXT NOT NULL,
      last_confirmed TEXT NOT NULL,
      superseded_by TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      scope TEXT NOT NULL DEFAULT 'team',
      developer_id TEXT,
      metadata TEXT
    )`);
    db.run(`CREATE TABLE relationships (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0,
      UNIQUE(source_id, target_id, type)
    )`);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO entries (id, type, title, content, file_path, created_at, last_confirmed)
       VALUES ('s1','structural','foo()','desc','src/a.ts',?,?),
              ('s2','structural','bar()','desc','src/b.ts',?,?),
              ('c1','convention','use tabs','team uses tabs',NULL,?,?)`,
      [now, now, now, now, now, now],
    );
    db.run(
      `INSERT INTO relationships (source_id, target_id, type, strength)
       VALUES ('s1','s2','calls',0.9)`,
    );
    db.close();

    // Re-open through initDatabase — migration should run.
    // Use a file path so initDatabase's init path executes (it does for :memory: too).
    const reopenedDb = new Database(":memory:");
    // Re-seed the in-memory DB because each Database(":memory:") is isolated.
    // Instead, we'll drive the migration by calling the real init helper
    // on a freshly-seeded file-based temp DB.
    reopenedDb.close();

    const tmp = `/tmp/structural-migration-${crypto.randomUUID()}.db`;
    const seed = new Database(tmp);
    // Force rollback-journal mode so the seed's writes are fully flushed
    // to the main file before initDatabase reopens the connection. WAL
    // leftovers trigger "database disk image is malformed" on custom
    // SQLite reload in tests.
    seed.run("PRAGMA journal_mode=DELETE");
    seed.run(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('error_pattern','convention','decision','learning','ghost_knowledge','structural')),
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      error_signature TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_count INTEGER NOT NULL DEFAULT 1,
      source_tool TEXT,
      created_at TEXT NOT NULL,
      last_confirmed TEXT NOT NULL,
      superseded_by TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      scope TEXT NOT NULL DEFAULT 'team',
      developer_id TEXT,
      metadata TEXT
    )`);
    seed.run(`CREATE TABLE relationships (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0,
      UNIQUE(source_id, target_id, type)
    )`);
    seed.run(
      `INSERT INTO entries (id, type, title, content, file_path, created_at, last_confirmed)
       VALUES ('s1','structural','foo()','desc','src/a.ts',?,?),
              ('s2','structural','bar()','desc','src/b.ts',?,?),
              ('c1','convention','use tabs','team uses tabs',NULL,?,?)`,
      [now, now, now, now, now, now],
    );
    seed.run(
      `INSERT INTO relationships (source_id, target_id, type, strength)
       VALUES ('s1','s2','calls',0.9)`,
    );
    seed.close();

    const migrated = initDatabase(tmp);
    try {
      const structural = migrated
        .query("SELECT COUNT(*) AS n FROM structural_nodes")
        .get() as { n: number };
      expect(structural.n).toBe(2);

      const structEdges = migrated
        .query("SELECT COUNT(*) AS n FROM structural_edges")
        .get() as { n: number };
      expect(structEdges.n).toBe(1);

      const remainingStructural = migrated
        .query("SELECT COUNT(*) AS n FROM entries WHERE type='structural'")
        .get() as { n: number };
      expect(remainingStructural.n).toBe(0);

      const convention = migrated
        .query("SELECT COUNT(*) AS n FROM entries WHERE type='convention'")
        .get() as { n: number };
      expect(convention.n).toBe(1);
    } finally {
      migrated.close();
      try {
        require("node:fs").unlinkSync(tmp);
        require("node:fs").unlinkSync(`${tmp}-wal`);
        require("node:fs").unlinkSync(`${tmp}-shm`);
      } catch {
        // ignore
      }
    }
  });
});
