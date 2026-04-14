/**
 * Tests for computeUniformityScore in src/store/uniformity.ts.
 *
 * All tests use an in-memory SQLite database via initDatabase(":memory:").
 * The schema is identical to production — no manual DDL needed.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { computeUniformityScore } from "../../src/store/uniformity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal entry row directly via SQL.
 * source_count is required by the schema (NOT NULL DEFAULT 1) and is set to 0
 * here to avoid FTS trigger issues; any value ≥ 0 is fine for these tests.
 */
function insertEntry(
  db: Database,
  opts: {
    id: string;
    type: "error_pattern" | "convention" | "decision" | "learning" | "ghost_knowledge";
    confidence?: number;
    status?: string;
    lastConfirmed?: string;
  },
): void {
  const {
    id,
    type,
    confidence = 0.5,
    status = "active",
    lastConfirmed = new Date().toISOString(),
  } = opts;

  db.run(
    `INSERT INTO entries
       (id, type, title, content, confidence, scope, status, created_at, last_confirmed, source_count)
     VALUES (?, ?, ?, ?, ?, 'team', ?, ?, ?, 0)`,
    [id, type, `Title ${id}`, `Content ${id}`, confidence, status, new Date().toISOString(), lastConfirmed],
  );
}

/** Associate a file path with an entry in entry_files. */
function insertEntryFile(db: Database, entryId: string, filePath: string): void {
  db.run(
    "INSERT INTO entry_files (entry_id, file_path) VALUES (?, ?)",
    [entryId, filePath],
  );
}

/** Return an ISO-8601 date string N days before today. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("computeUniformityScore", () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  // -------------------------------------------------------------------------
  // 1. Empty database
  // -------------------------------------------------------------------------

  test("empty DB returns score=0, coverage=0, ghost=0, freshness=1, style=0.5", () => {
    const report = computeUniformityScore(db);

    // score = (0*0.4 + 0*0.2 + 1*0.2 + 0.5*0.2)*100 = (0.2 + 0.1)*100 = 30
    expect(report.subscores.coverage).toBe(0);
    expect(report.subscores.ghost).toBe(0);
    expect(report.subscores.freshness).toBe(1);
    expect(report.subscores.style).toBe(0.5);

    const expected = Math.round((0 * 0.4 + 0 * 0.2 + 1 * 0.2 + 0.5 * 0.2) * 1000) / 10;
    expect(report.score).toBe(expected);

    expect(report.details.directoriesTotal).toBe(0);
    expect(report.details.directoriesCovered).toBe(0);
    expect(report.details.ghostCount).toBe(0);
    expect(report.details.avgFreshnessDays).toBe(0);
    expect(report.details.highConfidenceRatio).toBe(0.5);
  });

  // -------------------------------------------------------------------------
  // 2. Ghost subscore — 5 entries → ghost = 1.0
  // -------------------------------------------------------------------------

  test("5 active ghost_knowledge entries → ghost subscore = 1.0", () => {
    for (let i = 0; i < 5; i++) {
      insertEntry(db, { id: `ghost-${i}`, type: "ghost_knowledge" });
    }

    const report = computeUniformityScore(db);
    expect(report.subscores.ghost).toBe(1.0);
    expect(report.details.ghostCount).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 3. Ghost subscore — 3 entries → ghost = 0.6 (i.e. 1 - 3/5)
  // -------------------------------------------------------------------------

  test("3 active ghost_knowledge entries → ghost subscore = 0.6", () => {
    for (let i = 0; i < 3; i++) {
      insertEntry(db, { id: `ghost-${i}`, type: "ghost_knowledge" });
    }

    const report = computeUniformityScore(db);
    expect(report.subscores.ghost).toBeCloseTo(0.6, 9);
    expect(report.details.ghostCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 4. Freshness — convention confirmed today → freshness ≈ 1
  // -------------------------------------------------------------------------

  test("convention confirmed today → freshness ≈ 1", () => {
    insertEntry(db, {
      id: "conv-today",
      type: "convention",
      lastConfirmed: new Date().toISOString(),
    });

    const report = computeUniformityScore(db);
    // 0 days old → 1 - 0/90 = 1.0  (allow tiny floating-point drift)
    expect(report.subscores.freshness).toBeCloseTo(1, 1);
    expect(report.details.avgFreshnessDays).toBeCloseTo(0, 0);
  });

  // -------------------------------------------------------------------------
  // 5. Freshness — convention confirmed 90 days ago → freshness ≈ 0
  // -------------------------------------------------------------------------

  test("convention confirmed 90 days ago → freshness ≈ 0", () => {
    insertEntry(db, {
      id: "conv-old",
      type: "convention",
      lastConfirmed: daysAgo(90),
    });

    const report = computeUniformityScore(db);
    // 90 days old → 1 - 90/90 = 0.0  (allow ±1 day rounding)
    expect(report.subscores.freshness).toBeCloseTo(0, 0);
    expect(report.details.avgFreshnessDays).toBeCloseTo(90, 0);
  });

  // -------------------------------------------------------------------------
  // 6a. Style — both conventions high-confidence → style = 1.0
  // -------------------------------------------------------------------------

  test("two conventions with confidence 0.9 and 0.8 → style = 1.0", () => {
    insertEntry(db, { id: "conv-a", type: "convention", confidence: 0.9 });
    insertEntry(db, { id: "conv-b", type: "convention", confidence: 0.8 });

    const report = computeUniformityScore(db);
    expect(report.subscores.style).toBeCloseTo(1.0, 9);
    expect(report.details.highConfidenceRatio).toBeCloseTo(1.0, 9);
  });

  // -------------------------------------------------------------------------
  // 6b. Style — one high, one low → style = 0.5
  // -------------------------------------------------------------------------

  test("two conventions with confidence 0.9 and 0.5 → style = 0.5", () => {
    insertEntry(db, { id: "conv-hi", type: "convention", confidence: 0.9 });
    insertEntry(db, { id: "conv-lo", type: "convention", confidence: 0.5 });

    const report = computeUniformityScore(db);
    expect(report.subscores.style).toBeCloseTo(0.5, 9);
  });

  // -------------------------------------------------------------------------
  // 7. Coverage — directory with convention + non-convention in same dir
  // -------------------------------------------------------------------------

  test("directory with one convention entry → coverage > 0", () => {
    // A convention entry linked to src/foo.ts
    insertEntry(db, { id: "conv-src", type: "convention", confidence: 0.9 });
    insertEntryFile(db, "conv-src", "src/foo.ts");

    // A non-convention entry in the same directory
    insertEntry(db, { id: "learn-src", type: "learning" });
    insertEntryFile(db, "learn-src", "src/bar.ts");

    const report = computeUniformityScore(db);
    // Both files are in the "src" directory. "src" is covered by a convention.
    expect(report.subscores.coverage).toBeGreaterThan(0);
    expect(report.details.directoriesCovered).toBeGreaterThanOrEqual(1);
    expect(report.details.directoriesTotal).toBeGreaterThanOrEqual(1);
  });

  test("directory with only non-convention entries → coverage = 0", () => {
    insertEntry(db, { id: "learn-1", type: "learning" });
    insertEntryFile(db, "learn-1", "src/utils.ts");

    const report = computeUniformityScore(db);
    expect(report.subscores.coverage).toBe(0);
    expect(report.details.directoriesCovered).toBe(0);
    expect(report.details.directoriesTotal).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. Score formula correctness
  //    coverage=0.5, ghost=1.0, freshness=1.0, style=1.0
  //    → (0.5*0.4 + 1.0*0.2 + 1.0*0.2 + 1.0*0.2)*100 = 80.0
  // -------------------------------------------------------------------------

  test("formula check: coverage=0.5, ghost=1.0, freshness=1.0, style=1.0 → score=80", () => {
    // ghost = 1.0 → need ≥ 5 ghost_knowledge entries (Math.min(5/5, 1) = 1)
    for (let i = 0; i < 5; i++) {
      insertEntry(db, { id: `ghost-f-${i}`, type: "ghost_knowledge" });
    }

    // style = 1.0 → all conventions have confidence ≥ 0.8
    // freshness = 1.0 → convention confirmed today
    insertEntry(db, {
      id: "conv-fresh",
      type: "convention",
      confidence: 0.9,
      lastConfirmed: new Date().toISOString(),
    });

    // coverage = 0.5 → 1 of 2 directories has a convention
    // Directory "src" — has a convention (conv-fresh)
    insertEntryFile(db, "conv-fresh", "src/main.ts");

    // Directory "lib" — only a non-convention entry
    insertEntry(db, { id: "learn-lib", type: "learning" });
    insertEntryFile(db, "learn-lib", "lib/helpers.ts");

    const report = computeUniformityScore(db);

    expect(report.subscores.coverage).toBeCloseTo(0.5, 9);
    expect(report.subscores.ghost).toBeCloseTo(1.0, 9);
    expect(report.subscores.freshness).toBeCloseTo(1.0, 1);
    expect(report.subscores.style).toBeCloseTo(1.0, 9);
    expect(report.score).toBeCloseTo(80.0, 0);
  });

  // -------------------------------------------------------------------------
  // 9. Archived ghost entries do not count
  // -------------------------------------------------------------------------

  test("archived ghost_knowledge entries are not counted", () => {
    insertEntry(db, { id: "ghost-archived", type: "ghost_knowledge", status: "archived" });

    const report = computeUniformityScore(db);
    expect(report.details.ghostCount).toBe(0);
    expect(report.subscores.ghost).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 10. File at root level (no slash) → directory is '.'
  // -------------------------------------------------------------------------

  test("root-level file path (no slash) maps to '.' directory", () => {
    insertEntry(db, { id: "conv-root", type: "convention", confidence: 0.9 });
    insertEntryFile(db, "conv-root", "README.md");

    const report = computeUniformityScore(db);
    expect(report.details.directoriesTotal).toBe(1);
    expect(report.details.directoriesCovered).toBe(1);
    expect(report.subscores.coverage).toBe(1);
  });
});
