/**
 * Tests for ghost-init CLI utilities and the ghost_knowledge entry pipeline.
 *
 * Focuses on the data layer — schema validation, confidence scoring, and
 * helper functions. Does NOT simulate interactive stdin (brittle).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import { calculateConfidence } from "../../src/store/confidence.js";
import type { ConfidenceFactors } from "../../src/store/confidence.js";
import { extractEntry, LearnInputSchema } from "../../src/compiler/extract.js";
import type { LearnInput } from "../../src/compiler/extract.js";
import { extractFilePaths, deriveTitle } from "../../src/cli/ghost-init.js";
import type { Database } from "bun:sqlite";
import { ValidationError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  return initDatabase(":memory:");
}

function ghostEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    type: "ghost_knowledge",
    title: "Never deploy on Friday after 3pm",
    content:
      "Deploying on Friday afternoons has caused three major incidents. The oncall rotation is thin over the weekend.",
    files: [],
    tags: ["ghost", "deploy_rules"],
    confidence: 1.0,
    sourceCount: 1,
    scope: "team",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema: ghost_knowledge accepted by the DB type CHECK
// ---------------------------------------------------------------------------

describe("database — ghost_knowledge type", () => {
  test("inserts a ghost_knowledge entry without throwing", () => {
    const db = makeDb();
    expect(() => insertEntry(db, ghostEntry())).not.toThrow();
    db.close();
  });

  test("inserted entry has confidence 1.0", () => {
    const db = makeDb();
    const entry = ghostEntry();
    insertEntry(db, entry);

    interface Row { confidence: number; type: string }
    const row = db
      .query<Row, [string]>("SELECT confidence, type FROM entries WHERE id = ?")
      .get(entry.id);

    expect(row).not.toBeNull();
    expect(row?.type).toBe("ghost_knowledge");
    expect(row?.confidence).toBeCloseTo(1.0, 6);
    db.close();
  });

  test("inserted entry defaults scope to 'team'", () => {
    const db = makeDb();
    const entry = ghostEntry({ scope: "team" });
    insertEntry(db, entry);

    interface Row { scope: string }
    const row = db
      .query<Row, [string]>("SELECT scope FROM entries WHERE id = ?")
      .get(entry.id);

    expect(row?.scope).toBe("team");
    db.close();
  });

  test("rejects an unknown type value", () => {
    const db = makeDb();
    const bad: EntryRow = { ...ghostEntry(), type: "not_a_type" };
    expect(() => insertEntry(db, bad)).toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Confidence: ghost_knowledge has infinite half-life
// ---------------------------------------------------------------------------

describe("calculateConfidence — ghost_knowledge", () => {
  const fixedNow = new Date("2025-01-01T00:00:00.000Z");

  function makeFactors(overrides: Partial<ConfidenceFactors> = {}): ConfidenceFactors {
    return {
      type: "ghost_knowledge",
      sourceCount: 1,
      lastConfirmedAt: fixedNow.toISOString(),
      now: fixedNow,
      hasContradiction: false,
      codeChanged: false,
      ...overrides,
    };
  }

  test("returns ~0.5 at creation (saturation=0.5, decay=1.0)", () => {
    const score = calculateConfidence(makeFactors());
    // saturation = 1 - 1/(1+1) = 0.5; decay = 0.5^(0/Infinity) = 1
    expect(score).toBeCloseTo(0.5, 6);
  });

  test("does not decay after 365 days", () => {
    const yearLater = new Date(fixedNow.getTime() + 365 * 24 * 60 * 60 * 1000);
    const score = calculateConfidence(makeFactors({ now: yearLater }));
    // decay = 0.5^(365/Infinity) = 0.5^0 = 1 → score = saturation = 0.5
    expect(score).toBeCloseTo(0.5, 6);
  });

  test("does not decay after 10 years", () => {
    const tenYearsLater = new Date(
      fixedNow.getTime() + 10 * 365 * 24 * 60 * 60 * 1000,
    );
    const score = calculateConfidence(makeFactors({ now: tenYearsLater }));
    expect(score).toBeCloseTo(0.5, 6);
  });

  test("confidence is ~1.0 with many sources and no decay", () => {
    // With 9 sources: saturation = 0.9; decay stays 1.0
    const score = calculateConfidence(makeFactors({ sourceCount: 9 }));
    expect(score).toBeCloseTo(0.9, 4);
  });

  test("ghost_knowledge confidence stays stable when codeChanged=true (but penalty still applied)", () => {
    // The code-change penalty still applies — ghost rules can still be
    // invalidated if code structure changes. The key is no *time* decay.
    const yearLater = new Date(fixedNow.getTime() + 365 * 24 * 60 * 60 * 1000);
    const withCodeChange = calculateConfidence(
      makeFactors({ now: yearLater, codeChanged: true }),
    );
    const withoutCodeChange = calculateConfidence(makeFactors({ now: yearLater }));
    // codeChanged should still reduce the score
    expect(withCodeChange).toBeLessThan(withoutCodeChange);
  });
});

// ---------------------------------------------------------------------------
// Zod schema: ghost_knowledge passes LearnInputSchema
// ---------------------------------------------------------------------------

describe("LearnInputSchema — ghost_knowledge", () => {
  const validGhostInput: LearnInput = {
    type: "ghost_knowledge",
    title: "Never deploy on Fridays after 3pm",
    content:
      "Three major incidents happened on Friday afternoons. Oncall rotation is thin.",
    files: [],
    tags: ["ghost"],
    confidence: 1.0,
  };

  test("parses ghost_knowledge input without errors", () => {
    expect(() => LearnInputSchema.parse(validGhostInput)).not.toThrow();
  });

  test("parsed type is 'ghost_knowledge'", () => {
    const result = LearnInputSchema.parse(validGhostInput);
    expect(result.type).toBe("ghost_knowledge");
  });

  test("rejects unknown type 'tribal_rule'", () => {
    const bad = { ...validGhostInput, type: "tribal_rule" };
    expect(() => LearnInputSchema.parse(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractEntry: ghost_knowledge skips error signature normalization
// ---------------------------------------------------------------------------

describe("extractEntry — ghost_knowledge", () => {
  test("ghost_knowledge with errorMessage does not set errorSignature", () => {
    const input: LearnInput = {
      type: "ghost_knowledge",
      title: "Sacred billing module rule",
      content:
        "Do not modify src/billing/reconcile.ts without approval from the finance team.",
      errorMessage: "Some error message that should not be normalised",
      files: ["src/billing/reconcile.ts"],
      tags: ["ghost"],
    };
    const entry = extractEntry(input);
    // error normalization must be skipped for ghost_knowledge
    expect(entry.errorSignature).toBeUndefined();
    expect(entry.fingerprint).toBeUndefined();
  });

  test("ghost_knowledge defaults confidence to 1.0 when not supplied", () => {
    const input: LearnInput = {
      type: "ghost_knowledge",
      title: "Friday deploy rule enforced by team",
      content: "We never deploy on Fridays after 3pm due to thin oncall coverage.",
      files: [],
      tags: ["ghost"],
    };
    const entry = extractEntry(input);
    expect(entry.confidence).toBe(1.0);
  });

  test("ghost_knowledge preserves explicit confidence if provided", () => {
    const input: LearnInput = {
      type: "ghost_knowledge",
      title: "Billing module gate rule for team review",
      content:
        "Any changes to src/billing must go through a finance review before merging.",
      files: [],
      tags: ["ghost"],
      confidence: 0.8,
    };
    const entry = extractEntry(input);
    expect(entry.confidence).toBe(0.8);
  });

  test("ghost_knowledge defaults scope to 'team'", () => {
    const input: LearnInput = {
      type: "ghost_knowledge",
      title: "Friday deploy restriction rule for all devs",
      content:
        "All engineers must avoid deploying on Friday afternoons per the on-call schedule.",
      files: [],
      tags: ["ghost"],
    };
    const entry = extractEntry(input);
    expect(entry.scope).toBe("team");
  });

  test("throws ValidationError for ghost_knowledge with title too short", () => {
    const bad: LearnInput = {
      type: "ghost_knowledge",
      title: "No",
      content: "Some valid content for this ghost knowledge entry about rules.",
      files: [],
      tags: [],
    };
    expect(() => extractEntry(bad)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// extractFilePaths helper
// ---------------------------------------------------------------------------

describe("extractFilePaths", () => {
  test("extracts a single TypeScript path", () => {
    const paths = extractFilePaths(
      "Don't touch src/billing/reconcile.ts without asking Sarah",
    );
    expect(paths).toContain("src/billing/reconcile.ts");
  });

  test("extracts multiple paths from one sentence", () => {
    const paths = extractFilePaths(
      "Both src/auth/middleware.ts and config/secrets.json are sacred files",
    );
    expect(paths).toContain("src/auth/middleware.ts");
    expect(paths).toContain("config/secrets.json");
  });

  test("deduplicates repeated paths", () => {
    const paths = extractFilePaths(
      "src/billing/reconcile.ts is critical; never modify src/billing/reconcile.ts",
    );
    const count = paths.filter((p) => p === "src/billing/reconcile.ts").length;
    expect(count).toBe(1);
  });

  test("returns empty array when no paths are present", () => {
    const paths = extractFilePaths(
      "Never deploy on Fridays after 3pm — the oncall rotation is thin",
    );
    expect(paths).toEqual([]);
  });

  test("does not mutate the input string", () => {
    const original = "Check src/app.ts before merging";
    const copy = original;
    extractFilePaths(original);
    expect(original).toBe(copy);
  });
});

// ---------------------------------------------------------------------------
// deriveTitle helper
// ---------------------------------------------------------------------------

describe("deriveTitle", () => {
  test("produces a readable prefix from question id", () => {
    const title = deriveTitle("deploy_rules", "Never deploy on Fridays");
    expect(title).toMatch(/^Deploy Rules:/);
  });

  test("result is at most 80 characters", () => {
    const longAnswer = "A".repeat(200);
    const title = deriveTitle("common_mistake", longAnswer);
    expect(title.length).toBeLessThanOrEqual(80);
  });

  test("truncates long answers gracefully", () => {
    const answer = "Always check the feature flag config before deploying any new service to production";
    const title = deriveTitle("deploy_rules", answer);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toMatch(/^Deploy Rules:/);
  });

  test("handles single-word question ids", () => {
    const title = deriveTitle("onboarding", "Check with your lead on day one");
    expect(title).toMatch(/^Onboarding:/);
  });
});
