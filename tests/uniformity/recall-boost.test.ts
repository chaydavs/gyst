/**
 * Tests for recall tier + boost logic applied to search results.
 *
 * These tests validate the pure sorting/scoring logic extracted from
 * recall.ts — they do not go through MCP or the full recall pipeline.
 *
 * Covers:
 *   - Convention entries receive a +0.05 score boost when files are provided.
 *   - ghost_knowledge is always tier 0 (highest priority).
 *   - convention is tier 1, sorting above learning/decision (tier 2).
 *   - Title prefix "📏 Convention: " is applied to convention entries.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers mirroring recall.ts logic
// ---------------------------------------------------------------------------

/** Mirrors the tier assignment in recall.ts */
function tierOf(type: string): number {
  if (type === "ghost_knowledge") return 0;
  if (type === "convention") return 1;
  return 2;
}

/** Mirrors the boost logic in recall.ts */
function applyBoost(score: number, type: string, files: string[]): number {
  if (files.length > 0 && type === "convention") {
    return Math.min(1.0, score + 0.05);
  }
  return score;
}

/** Sort comparator mirroring recall.ts */
function compareEntries(
  a: { type: string; score: number },
  b: { type: string; score: number },
): number {
  const tierDiff = tierOf(a.type) - tierOf(b.type);
  if (tierDiff !== 0) return tierDiff;
  return b.score - a.score;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recall convention boost", () => {
  test("convention type gets +0.05 boost when files provided", () => {
    const baseScore = 0.5;
    const files = ["src/api/users.ts"];
    const boosted = applyBoost(baseScore, "convention", files);
    expect(boosted).toBeCloseTo(0.55);
  });

  test("convention boost is capped at 1.0", () => {
    const boosted = applyBoost(0.99, "convention", ["src/api/users.ts"]);
    expect(boosted).toBeLessThanOrEqual(1.0);
  });

  test("non-convention types receive no boost even with files", () => {
    const files = ["src/api/users.ts"];
    expect(applyBoost(0.5, "learning", files)).toBe(0.5);
    expect(applyBoost(0.5, "decision", files)).toBe(0.5);
    expect(applyBoost(0.5, "error_pattern", files)).toBe(0.5);
    expect(applyBoost(0.5, "ghost_knowledge", files)).toBe(0.5);
  });

  test("convention receives no boost when no files provided", () => {
    const boosted = applyBoost(0.5, "convention", []);
    expect(boosted).toBe(0.5);
  });

  test("ghost_knowledge always scores tier 0 (highest priority)", () => {
    expect(tierOf("ghost_knowledge")).toBe(0);
    expect(tierOf("convention")).toBe(1);
    expect(tierOf("learning")).toBe(2);
    expect(tierOf("decision")).toBe(2);
    expect(tierOf("error_pattern")).toBe(2);
  });

  test("convention sorts above learning with equal base score", () => {
    const entries = [
      { id: "a", type: "learning", score: 0.9 },
      { id: "b", type: "convention", score: 0.5 },
      { id: "c", type: "ghost_knowledge", score: 0.3 },
    ];
    const sorted = [...entries].sort(compareEntries);
    expect(sorted[0]!.type).toBe("ghost_knowledge");
    expect(sorted[1]!.type).toBe("convention");
    expect(sorted[2]!.type).toBe("learning");
  });

  test("within same tier, higher score sorts first", () => {
    const entries = [
      { id: "a", type: "learning", score: 0.3 },
      { id: "b", type: "learning", score: 0.9 },
      { id: "c", type: "learning", score: 0.6 },
    ];
    const sorted = [...entries].sort(compareEntries);
    expect(sorted[0]!.score).toBe(0.9);
    expect(sorted[1]!.score).toBe(0.6);
    expect(sorted[2]!.score).toBe(0.3);
  });

  test("decision and error_pattern both sit at tier 2 below convention", () => {
    const entries = [
      { id: "a", type: "error_pattern", score: 1.0 },
      { id: "b", type: "decision", score: 1.0 },
      { id: "c", type: "convention", score: 0.1 },
    ];
    const sorted = [...entries].sort(compareEntries);
    expect(sorted[0]!.type).toBe("convention");
  });

  test("📏 Convention: prefix applied to convention titles", () => {
    const entry = { type: "convention", title: "Naming: src/api uses camelCase" };
    const title =
      entry.type === "convention"
        ? `📏 Convention: ${entry.title}`
        : entry.title;
    expect(title).toBe("📏 Convention: Naming: src/api uses camelCase");
  });

  test("non-convention titles are returned unchanged", () => {
    const entry = { type: "learning", title: "Some learning" };
    const title =
      entry.type === "convention"
        ? `📏 Convention: ${entry.title}`
        : entry.title;
    expect(title).toBe("Some learning");
  });
});
