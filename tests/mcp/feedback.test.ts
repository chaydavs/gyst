/**
 * Tests for the feedback MCP tool logic.
 *
 * Rather than testing through the full MCP protocol layer, these tests
 * exercise the underlying database operations directly. This matches the
 * pattern established in tests/mcp/tools.test.ts.
 *
 * Scenarios tested:
 *  - Recording feedback for an existing entry creates a row
 *  - Recording feedback for a nonexistent entry returns a helpful message
 *  - helpful=true and helpful=false both store the correct integer value
 *  - Optional note is stored when provided, null when omitted
 *  - developer_id is stored when provided, null when omitted
 *  - Feedback can be queried by entry_id via the index
 *  - Multiple feedback rows can exist for the same entry
 *  - Cascade delete removes feedback when the parent entry is deleted
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_NOW = new Date("2025-04-11T00:00:00.000Z").toISOString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shape returned by a feedback row query */
interface FeedbackRow {
  id: number;
  entry_id: string;
  developer_id: string | null;
  helpful: number;
  note: string | null;
  timestamp: string;
}

/**
 * Inserts a minimal active entry and returns its id.
 */
function seedEntry(
  db: Database,
  overrides: Partial<{
    id: string;
    type: "error_pattern" | "convention" | "decision" | "learning";
    title: string;
    content: string;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  insertEntry(db, {
    id,
    type: overrides.type ?? "learning",
    title: overrides.title ?? "Test entry title",
    content: overrides.content ?? "Test entry content for feedback tests.",
    files: [],
    tags: [],
    confidence: 0.5,
    sourceCount: 1,
    createdAt: TEST_NOW,
    lastConfirmed: TEST_NOW,
    status: "active",
  });
  return id;
}

/**
 * Simulates the database write performed by the feedback tool handler.
 * Returns null if the entry does not exist, otherwise returns the inserted row.
 */
function simulateFeedback(
  db: Database,
  input: {
    entry_id: string;
    helpful: boolean;
    note?: string;
    developer_id?: string;
  },
): { success: true; text: string } | { success: false; text: string } {
  // Verify entry exists (mirrors the tool's guard)
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM entries WHERE id = ?")
    .get(input.entry_id);

  if (existing === null) {
    return {
      success: false,
      text: `Entry ${input.entry_id} not found.`,
    };
  }

  db.run(
    `INSERT INTO feedback (entry_id, developer_id, helpful, note, timestamp)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [
      input.entry_id,
      input.developer_id ?? null,
      input.helpful ? 1 : 0,
      input.note ?? null,
    ],
  );

  return {
    success: true,
    text: `Feedback recorded for entry ${input.entry_id}: ${input.helpful ? "helpful" : "not helpful"}`,
  };
}

// ---------------------------------------------------------------------------
// Test database lifecycle
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// feedback tool tests
// ---------------------------------------------------------------------------

describe("feedback tool — recording", () => {
  test("recording feedback for an existing entry creates a row in the feedback table", () => {
    const entryId = seedEntry(db);

    const result = simulateFeedback(db, { entry_id: entryId, helpful: true });

    expect(result.success).toBe(true);

    const row = db
      .query<FeedbackRow, [string]>(
        "SELECT * FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row).not.toBeNull();
    expect(row?.entry_id).toBe(entryId);
  });

  test("recording feedback for a nonexistent entry returns a not-found message", () => {
    const result = simulateFeedback(db, {
      entry_id: "does-not-exist",
      helpful: true,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("does-not-exist");
    expect(result.text).toContain("not found");

    // No row should have been written
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM feedback")
      .get();
    expect(count?.n).toBe(0);
  });

  test("helpful=true stores 1 in the helpful column", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: true });

    const row = db
      .query<{ helpful: number }, [string]>(
        "SELECT helpful FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row?.helpful).toBe(1);
  });

  test("helpful=false stores 0 in the helpful column", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: false });

    const row = db
      .query<{ helpful: number }, [string]>(
        "SELECT helpful FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row?.helpful).toBe(0);
  });

  test("optional note is stored when provided", () => {
    const entryId = seedEntry(db);
    const note = "This entry solved my exact problem immediately.";

    simulateFeedback(db, { entry_id: entryId, helpful: true, note });

    const row = db
      .query<{ note: string | null }, [string]>(
        "SELECT note FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row?.note).toBe(note);
  });

  test("note is stored as null when not provided", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: true });

    const row = db
      .query<{ note: string | null }, [string]>(
        "SELECT note FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row?.note).toBeNull();
  });

  test("developer_id is stored when provided", () => {
    const entryId = seedEntry(db);
    const developerId = "dev-alice";

    simulateFeedback(db, {
      entry_id: entryId,
      helpful: true,
      developer_id: developerId,
    });

    const row = db
      .query<{ developer_id: string | null }, [string]>(
        "SELECT developer_id FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row?.developer_id).toBe(developerId);
  });

  test("developer_id is stored as null when not provided", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: false });

    const row = db
      .query<{ developer_id: string | null }, [string]>(
        "SELECT developer_id FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);

    expect(row?.developer_id).toBeNull();
  });

  test("response text confirms helpfulness on positive feedback", () => {
    const entryId = seedEntry(db);

    const result = simulateFeedback(db, { entry_id: entryId, helpful: true });

    expect(result.success).toBe(true);
    expect(result.text).toContain("helpful");
    expect(result.text).toContain(entryId);
  });

  test("response text confirms unhelpfulness on negative feedback", () => {
    const entryId = seedEntry(db);

    const result = simulateFeedback(db, { entry_id: entryId, helpful: false });

    expect(result.success).toBe(true);
    expect(result.text).toContain("not helpful");
    expect(result.text).toContain(entryId);
  });
});

describe("feedback tool — querying by entry_id", () => {
  test("feedback can be queried by entry_id", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: true });
    simulateFeedback(db, { entry_id: entryId, helpful: false });

    const rows = db
      .query<FeedbackRow, [string]>(
        "SELECT * FROM feedback WHERE entry_id = ? ORDER BY id ASC",
      )
      .all(entryId);

    expect(rows.length).toBe(2);
    expect(rows[0]!.helpful).toBe(1);
    expect(rows[1]!.helpful).toBe(0);
  });

  test("multiple entries can each have independent feedback rows", () => {
    const entryA = seedEntry(db, { id: "entry-a" });
    const entryB = seedEntry(db, { id: "entry-b" });

    simulateFeedback(db, { entry_id: entryA, helpful: true });
    simulateFeedback(db, { entry_id: entryA, helpful: true });
    simulateFeedback(db, { entry_id: entryB, helpful: false });

    const rowsA = db
      .query<FeedbackRow, [string]>(
        "SELECT * FROM feedback WHERE entry_id = ?",
      )
      .all(entryA);

    const rowsB = db
      .query<FeedbackRow, [string]>(
        "SELECT * FROM feedback WHERE entry_id = ?",
      )
      .all(entryB);

    expect(rowsA.length).toBe(2);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0]!.helpful).toBe(0);
  });

  test("feedback rows for an entry are cascade-deleted when the entry is deleted", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: true });
    simulateFeedback(db, { entry_id: entryId, helpful: false });

    // Confirm rows exist before deletion
    const before = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);
    expect(before?.n).toBe(2);

    // Delete the parent entry
    db.run("DELETE FROM entries WHERE id = ?", [entryId]);

    // Feedback rows should be gone too (ON DELETE CASCADE)
    const after = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM feedback WHERE entry_id = ?",
      )
      .get(entryId);
    expect(after?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Confidence update tests (feedback loop)
// ---------------------------------------------------------------------------

/**
 * Simulates the full feedback tool handler, including the confidence update,
 * mirroring the transaction logic in src/mcp/tools/feedback.ts.
 */
function simulateFeedbackWithConfidence(
  db: Database,
  input: {
    entry_id: string;
    helpful: boolean;
    note?: string;
    developer_id?: string;
  },
): { success: boolean; text: string } {
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM entries WHERE id = ?")
    .get(input.entry_id);

  if (existing === null) {
    return { success: false, text: `Entry ${input.entry_id} not found.` };
  }

  let before: { confidence: number } | null = null;
  let after: { confidence: number } | null = null;

  db.transaction(() => {
    db.run(
      `INSERT INTO feedback (entry_id, developer_id, helpful, note, timestamp)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [
        input.entry_id,
        input.developer_id ?? null,
        input.helpful ? 1 : 0,
        input.note ?? null,
      ],
    );

    before = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(input.entry_id);

    db.run(
      "UPDATE entries SET confidence = MAX(0.0, MIN(1.0, confidence + ?)) WHERE id = ?",
      [input.helpful ? 0.02 : -0.05, input.entry_id],
    );

    after = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(input.entry_id);
  })();

  const beforeConf = (before as { confidence: number } | null)?.confidence;
  const afterConf = (after as { confidence: number } | null)?.confidence;

  return {
    success: true,
    text: `Feedback recorded for entry ${input.entry_id}: ${input.helpful ? "helpful" : "not helpful"} (confidence ${beforeConf?.toFixed(3)} → ${afterConf?.toFixed(3)})`,
  };
}

describe("feedback tool — confidence updates", () => {
  test("helpful=true increases confidence by 0.02", () => {
    const entryId = seedEntry(db);
    // seedEntry sets confidence to 0.5

    simulateFeedbackWithConfidence(db, { entry_id: entryId, helpful: true });

    const row = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(entryId);

    expect(row?.confidence).toBeCloseTo(0.52, 3);
  });

  test("helpful=false decreases confidence by 0.05", () => {
    const entryId = seedEntry(db);
    // seedEntry sets confidence to 0.5

    simulateFeedbackWithConfidence(db, { entry_id: entryId, helpful: false });

    const row = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(entryId);

    expect(row?.confidence).toBeCloseTo(0.45, 3);
  });

  test("confidence is capped at 1.0 when helpful on near-max entry", () => {
    const entryId = seedEntry(db, { id: "cap-test" });
    // Override confidence to 0.99
    db.run("UPDATE entries SET confidence = 0.99 WHERE id = ?", [entryId]);

    simulateFeedbackWithConfidence(db, { entry_id: entryId, helpful: true });

    const row = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(entryId);

    expect(row?.confidence).toBe(1.0);
  });

  test("confidence is floored at 0.0 when unhelpful on near-zero entry", () => {
    const entryId = seedEntry(db, { id: "floor-test" });
    // Override confidence to 0.03
    db.run("UPDATE entries SET confidence = 0.03 WHERE id = ?", [entryId]);

    simulateFeedbackWithConfidence(db, { entry_id: entryId, helpful: false });

    const row = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(entryId);

    expect(row?.confidence).toBe(0.0);
  });

  test("feedback for unknown entry returns not-found message", () => {
    const result = simulateFeedbackWithConfidence(db, {
      entry_id: "nonexistent-id",
      helpful: true,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("not found");
  });

  test("return text includes old and new confidence separated by →", () => {
    const entryId = seedEntry(db);

    const result = simulateFeedbackWithConfidence(db, {
      entry_id: entryId,
      helpful: true,
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("→");
  });
});

describe("feedback tool — aggregation queries (used by calibration script)", () => {
  test("positive rate is computed correctly across multiple feedback rows", () => {
    const entryId = seedEntry(db);

    // 3 helpful, 1 not helpful
    simulateFeedback(db, { entry_id: entryId, helpful: true });
    simulateFeedback(db, { entry_id: entryId, helpful: true });
    simulateFeedback(db, { entry_id: entryId, helpful: true });
    simulateFeedback(db, { entry_id: entryId, helpful: false });

    const result = db
      .query<{ total: number; positive: number }, []>(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS positive
         FROM feedback`,
      )
      .get();

    expect(result?.total).toBe(4);
    expect(result?.positive).toBe(3);
  });

  test("feedback join with entries returns confidence for calibration bucketing", () => {
    const entryId = seedEntry(db);

    simulateFeedback(db, { entry_id: entryId, helpful: true });

    const row = db
      .query<{ confidence: number; helpful: number }, []>(
        `SELECT e.confidence, f.helpful
         FROM feedback f
         JOIN entries e ON e.id = f.entry_id`,
      )
      .get();

    expect(row).not.toBeNull();
    expect(typeof row?.confidence).toBe("number");
    expect(row?.helpful).toBe(1);
  });
});
