import { describe, expect, test } from "bun:test";
import {
  applyIntentBoost,
  classifyIntent,
  INTENT_BOOSTS,
  type QueryIntent,
} from "../../src/store/intent.js";
import type { EntryRow } from "../../src/store/entries.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, type: string): EntryRow {
  return {
    id,
    type,
    title: `${type} entry`,
    content: "test content",
    confidence: 0.8,
    scope: "team",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastConfirmed: "2026-01-01T00:00:00.000Z",
    sourceCount: 1,
    sourceTool: null,
    developerId: null,
  };
}

// ---------------------------------------------------------------------------
// classifyIntent — debugging
// ---------------------------------------------------------------------------

describe("classifyIntent — debugging", () => {
  test('"fix the auth bug" → debugging', () => {
    expect(classifyIntent("fix the auth bug")).toBe("debugging");
  });

  test('"error in production" → debugging', () => {
    expect(classifyIntent("error in production")).toBe("debugging");
  });

  test('"TypeError: undefined is not a function" → debugging', () => {
    expect(classifyIntent("TypeError: undefined is not a function")).toBe(
      "debugging",
    );
  });

  test('"the server keeps failing with exception" → debugging', () => {
    expect(classifyIntent("the server keeps failing with exception")).toBe("debugging");
  });

  test('"that broken import throws at runtime" → debugging', () => {
    expect(classifyIntent("that broken import throws at runtime")).toBe(
      "debugging",
    );
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — conventions
// ---------------------------------------------------------------------------

describe("classifyIntent — conventions", () => {
  test('"naming conventions for functions" → conventions', () => {
    expect(classifyIntent("naming conventions for functions")).toBe(
      "conventions",
    );
  });

  test('"format rules for this codebase" → conventions', () => {
    expect(classifyIntent("format rules for this codebase")).toBe("conventions");
  });

  test('"what lint rules do we enforce" → conventions', () => {
    expect(classifyIntent("what lint rules do we enforce")).toBe("conventions");
  });

  test('"keep style consistent across files" → conventions', () => {
    expect(classifyIntent("keep style consistent across files")).toBe(
      "conventions",
    );
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — history
// ---------------------------------------------------------------------------

describe("classifyIntent — history", () => {
  test('"why did we choose SQLite" → history', () => {
    expect(classifyIntent("why did we choose SQLite")).toBe("history");
  });

  test('"who decided to use Bun" → history', () => {
    expect(classifyIntent("who decided to use Bun")).toBe("history");
  });

  test('"when was this changed" → history', () => {
    expect(classifyIntent("when was this changed")).toBe("history");
  });

  test('"what was the rationale for removing Redux" → history', () => {
    expect(classifyIntent("what was the rationale for removing Redux")).toBe(
      "history",
    );
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — writing_code
// ---------------------------------------------------------------------------

describe("classifyIntent — writing_code", () => {
  test('"write a new auth handler" → writing_code', () => {
    expect(classifyIntent("write a new auth handler")).toBe("writing_code");
  });

  test('"implement the user service" → writing_code', () => {
    expect(classifyIntent("implement the user service")).toBe("writing_code");
  });

  test('"create a new component" → writing_code', () => {
    expect(classifyIntent("create a new component")).toBe("writing_code");
  });

  test('"scaffold a new API route" → writing_code', () => {
    expect(classifyIntent("scaffold a new API route")).toBe("writing_code");
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — general (default)
// ---------------------------------------------------------------------------

describe("classifyIntent — general (default)", () => {
  test('"how does recall work" → general', () => {
    expect(classifyIntent("how does recall work")).toBe("general");
  });

  test("empty string → general", () => {
    expect(classifyIntent("")).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// applyIntentBoost
// ---------------------------------------------------------------------------

describe("applyIntentBoost", () => {
  test("empty entries + any intent → empty map", () => {
    const result = applyIntentBoost([], new Map(), "debugging");
    expect(result.size).toBe(0);
  });

  test("debugging: error_pattern entry gets +0.15 boost", () => {
    const entries = [makeEntry("e1", "error_pattern")];
    const scores: ReadonlyMap<string, number> = new Map([["e1", 0.50]]);
    const result = applyIntentBoost(entries, scores, "debugging");
    expect(result.get("e1")).toBeCloseTo(0.65);
  });

  test("debugging: convention entry gets no boost", () => {
    const entries = [makeEntry("e2", "convention")];
    const scores: ReadonlyMap<string, number> = new Map([["e2", 0.50]]);
    const result = applyIntentBoost(entries, scores, "debugging");
    expect(result.get("e2")).toBeCloseTo(0.50);
  });

  test("debugging: learning entry gets +0.08 boost", () => {
    const entries = [makeEntry("e3", "learning")];
    const scores: ReadonlyMap<string, number> = new Map([["e3", 0.40]]);
    const result = applyIntentBoost(entries, scores, "debugging");
    expect(result.get("e3")).toBeCloseTo(0.48);
  });

  test("writing_code: convention entry gets +0.10 boost", () => {
    const entries = [makeEntry("e4", "convention")];
    const scores: ReadonlyMap<string, number> = new Map([["e4", 0.60]]);
    const result = applyIntentBoost(entries, scores, "writing_code");
    expect(result.get("e4")).toBeCloseTo(0.70);
  });

  test("writing_code: error_pattern entry gets no boost", () => {
    const entries = [makeEntry("e5", "error_pattern")];
    const scores: ReadonlyMap<string, number> = new Map([["e5", 0.60]]);
    const result = applyIntentBoost(entries, scores, "writing_code");
    expect(result.get("e5")).toBeCloseTo(0.60);
  });

  test("general: no boosts applied — output equals input scores", () => {
    const entries = [
      makeEntry("g1", "convention"),
      makeEntry("g2", "error_pattern"),
      makeEntry("g3", "decision"),
    ];
    const scores: ReadonlyMap<string, number> = new Map([
      ["g1", 0.55],
      ["g2", 0.70],
      ["g3", 0.30],
    ]);
    const result = applyIntentBoost(entries, scores, "general");
    expect(result.get("g1")).toBeCloseTo(0.55);
    expect(result.get("g2")).toBeCloseTo(0.70);
    expect(result.get("g3")).toBeCloseTo(0.30);
  });

  test("score capped at 1.0 (base=0.9 + boost=0.15 → 1.0, not 1.05)", () => {
    const entries = [makeEntry("cap1", "error_pattern")];
    const scores: ReadonlyMap<string, number> = new Map([["cap1", 0.90]]);
    const result = applyIntentBoost(entries, scores, "debugging");
    expect(result.get("cap1")).toBe(1.0);
  });

  test("entries not in scores map start from base 0.0", () => {
    const entries = [makeEntry("new1", "error_pattern")];
    const scores: ReadonlyMap<string, number> = new Map(); // entry absent
    const result = applyIntentBoost(entries, scores, "debugging");
    expect(result.get("new1")).toBeCloseTo(0.15);
  });

  test("result map is a new Map — input scores are not mutated", () => {
    const entries = [makeEntry("m1", "convention")];
    const original = new Map([["m1", 0.40]]);
    const scoresBefore = original.get("m1");
    applyIntentBoost(entries, original, "conventions");
    expect(original.get("m1")).toBe(scoresBefore); // still 0.40
  });

  test("history: decision entry gets +0.12 boost", () => {
    const entries = [makeEntry("h1", "decision")];
    const scores: ReadonlyMap<string, number> = new Map([["h1", 0.50]]);
    const result = applyIntentBoost(entries, scores, "history");
    expect(result.get("h1")).toBeCloseTo(0.62);
  });

  test("history: ghost_knowledge entry gets +0.05 boost", () => {
    const entries = [makeEntry("h2", "ghost_knowledge")];
    const scores: ReadonlyMap<string, number> = new Map([["h2", 0.50]]);
    const result = applyIntentBoost(entries, scores, "history");
    expect(result.get("h2")).toBeCloseTo(0.55);
  });

  test("multiple entries in one call — each boosted independently", () => {
    const entries = [
      makeEntry("m1", "error_pattern"),
      makeEntry("m2", "learning"),
      makeEntry("m3", "convention"),
    ];
    const scores: ReadonlyMap<string, number> = new Map([
      ["m1", 0.50],
      ["m2", 0.50],
      ["m3", 0.50],
    ]);
    const result = applyIntentBoost(entries, scores, "debugging");
    expect(result.get("m1")).toBeCloseTo(0.65);
    expect(result.get("m2")).toBeCloseTo(0.58);
    expect(result.get("m3")).toBeCloseTo(0.50);
  });

  test("INTENT_BOOSTS general object is empty — no entry type gets a boost", () => {
    expect(Object.keys(INTENT_BOOSTS.general)).toHaveLength(0);
  });

  test("INTENT_BOOSTS values for all intents are defined", () => {
    const intents: QueryIntent[] = [
      "debugging",
      "writing_code",
      "conventions",
      "history",
      "general",
    ];
    for (const intent of intents) {
      expect(INTENT_BOOSTS[intent]).toBeDefined();
    }
  });
});
