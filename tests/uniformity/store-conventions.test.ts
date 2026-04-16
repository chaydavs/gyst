/**
 * Tests for storeDetectedConventions() — persists detected conventions to SQLite.
 *
 * Uses an in-memory database for isolation.  Each test re-creates the DB so
 * entries from one case don't bleed into another.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { storeDetectedConventions } from "../../src/compiler/store-conventions.js";
import type { DetectedConvention } from "../../src/compiler/detect-conventions.js";

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeConvention(
  overrides: Partial<DetectedConvention> = {},
): DetectedConvention {
  return {
    category: "naming",
    directory: "src/api",
    pattern: "camelCase functions",
    confidence: 0.85,
    evidence: {
      filesScanned: 6,
      filesMatching: 5,
      examples: ["src/api/users.ts"],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storeDetectedConventions", () => {
  test("empty input returns 0", async () => {
    const count = await storeDetectedConventions(db, []);
    expect(count).toBe(0);
  });

  test("convention below 0.6 confidence threshold is filtered and returns 0", async () => {
    const lowConfidence = makeConvention({ confidence: 0.4 });
    const count = await storeDetectedConventions(db, [lowConfidence]);
    expect(count).toBe(0);
  });

  test("convention at exactly 0.6 confidence is stored (boundary)", async () => {
    const borderline = makeConvention({ confidence: 0.6 });
    const count = await storeDetectedConventions(db, [borderline]);
    expect(count).toBe(1);
  });

  test("stores a valid convention and returns 1", async () => {
    const convention = makeConvention({ confidence: 0.85 });
    const count = await storeDetectedConventions(db, [convention]);
    expect(count).toBe(1);

    const row = db
      .query<{ cnt: number }, []>(
        "SELECT count(*) AS cnt FROM entries WHERE type = 'convention'",
      )
      .get();
    expect(row?.cnt).toBe(1);
  });

  test("title format is '<Category>: <directory> uses <pattern>'", async () => {
    const convention = makeConvention({
      category: "naming",
      directory: "src/api",
      pattern: "camelCase functions",
      confidence: 0.85,
    });
    await storeDetectedConventions(db, [convention]);

    const row = db
      .query<{ title: string }, []>(
        "SELECT title FROM entries WHERE type = 'convention'",
      )
      .get();

    expect(row?.title).toBe("Naming: src/api uses camelCase functions");
  });

  test("files stored with trailing slash for directory-level matching", async () => {
    const convention = makeConvention({
      directory: "src/api",
      confidence: 0.85,
    });
    await storeDetectedConventions(db, [convention]);

    const row = db
      .query<{ file_path: string }, []>(
        `SELECT ef.file_path
         FROM entry_files ef
         JOIN entries e ON e.id = ef.entry_id
         WHERE e.type = 'convention'
         LIMIT 1`,
      )
      .get();

    expect(row).toBeDefined();
    expect(row!.file_path.endsWith("/")).toBe(true);
  });

  test("stores multiple conventions and returns correct count", async () => {
    const conventions: DetectedConvention[] = [
      makeConvention({ category: "naming", pattern: "camelCase functions" }),
      makeConvention({ category: "imports", pattern: "relative imports" }),
      makeConvention({ category: "exports", pattern: "named exports" }),
    ];
    const count = await storeDetectedConventions(db, conventions);
    expect(count).toBe(3);
  });

  test("mixed confidence: only above-threshold entries are stored", async () => {
    // Distinct patterns so consolidateConventions (keyed on category::pattern)
    // doesn't collapse them — this test exercises the confidence filter alone.
    const conventions: DetectedConvention[] = [
      makeConvention({ confidence: 0.9, pattern: "camelCase functions" }),
      makeConvention({ confidence: 0.3, pattern: "snake_case constants" }),  // below threshold
      makeConvention({ confidence: 0.7, pattern: "PascalCase types" }),
      makeConvention({ confidence: 0.1, pattern: "kebab-case files" }),  // below threshold
    ];
    const count = await storeDetectedConventions(db, conventions);
    expect(count).toBe(2);
  });

  test("deduplication: calling storeDetectedConventions twice does not create duplicate entries", async () => {
    const convention = makeConvention({ confidence: 0.85 });

    // First call stores it.
    const firstCount = await storeDetectedConventions(db, [convention]);
    expect(firstCount).toBe(1);

    // Second call with the identical convention must be skipped — already in DB.
    const secondCount = await storeDetectedConventions(db, [convention]);
    expect(secondCount).toBe(0);

    // Only one row in the database.
    const row = db
      .query<{ cnt: number }, []>(
        "SELECT count(*) AS cnt FROM entries WHERE type = 'convention'",
      )
      .get();
    expect(row?.cnt).toBe(1);
  });

  test("deduplication: only the new convention is stored when one already exists", async () => {
    const existing = makeConvention({ category: "naming", pattern: "camelCase functions" });
    const fresh = makeConvention({ category: "imports", pattern: "relative imports" });

    // Store the first one.
    await storeDetectedConventions(db, [existing]);

    // Now submit both; only the fresh one should be written.
    const count = await storeDetectedConventions(db, [existing, fresh]);
    expect(count).toBe(1);

    // Total in DB is 2 (one from first call, one from second).
    const row = db
      .query<{ cnt: number }, []>(
        "SELECT count(*) AS cnt FROM entries WHERE type = 'convention'",
      )
      .get();
    expect(row?.cnt).toBe(2);
  });
});
