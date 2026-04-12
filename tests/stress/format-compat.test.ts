/**
 * Stress test: adaptive context budget formatting compatibility.
 *
 * Verifies that formatForContext correctly selects tier formatters based on
 * token budget, respects entry count limits, stays within budget, and handles
 * edge cases (empty input, extreme budgets).
 *
 * Format tiers:
 *   full         (>= 5000): up to 5 entries — "## title (type, conf)\ncontent\n---"
 *   compact      (>= 2000): up to 3 entries — "### title (conf)\nfirst 2 sentences\n---"
 *   minimal      (>=  800): up to 2 entries — "- title: first 80 chars"
 *   ultraMinimal (<  800):  1 entry         — "title\nfirst sentence"
 */

import { describe, test, expect } from "bun:test";
import { formatForContext } from "../../src/utils/format-recall.js";
import type { FormattableEntry } from "../../src/utils/format-recall.js";
import { countTokens } from "../../src/utils/tokens.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(i: number, typeOverride?: string): FormattableEntry {
  const type = typeOverride ?? "learning";
  return {
    id: `entry-${i}`,
    type,
    title: `Sample entry ${i} for ${type}`,
    content: `This is the content for entry ${i}. It describes a ${type} pattern with important details. The fix is to always validate input at system boundaries. Make sure to check edge cases and handle errors explicitly.`,
    confidence: 0.5 + i * 0.04,
    files: [`src/module-${i}.ts`],
    tags: ["test", type],
  };
}

const ghostEntry: FormattableEntry = {
  id: "ghost-1",
  type: "ghost_knowledge",
  title: "No sensitive data in logs",
  content:
    "Team rule: never log PII, API keys, or tokens. This is a hard requirement from security. Violation results in immediate incident response.",
  confidence: 1.0,
  files: [],
  tags: ["security", "logging"],
};

// 8 diverse entries for tier tests
const entries8 = [
  makeEntry(0, "error_pattern"),
  makeEntry(1, "convention"),
  makeEntry(2, "decision"),
  makeEntry(3, "learning"),
  makeEntry(4, "error_pattern"),
  makeEntry(5, "convention"),
  makeEntry(6, "decision"),
  makeEntry(7, "learning"),
];

// ---------------------------------------------------------------------------
// Context budget tiers
// ---------------------------------------------------------------------------

describe("context budget tiers", () => {
  test("full tier (budget=5000) — up to 5 entries, full content", () => {
    const output = formatForContext(entries8, 5000);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);

    // Full format uses ## headings
    const headingMatches = (output.match(/^## /gm) ?? []).length;
    expect(headingMatches).toBeLessThanOrEqual(5);
    expect(headingMatches).toBeGreaterThanOrEqual(1);

    // Must not exceed budget
    expect(countTokens(output)).toBeLessThanOrEqual(5000);

    // Full content should appear (at least first entry's content partially)
    expect(output).toContain(entries8[0]!.title);
  });

  test("compact tier (budget=2000) — up to 3 entries", () => {
    const output = formatForContext(entries8, 2000);
    expect(typeof output).toBe("string");

    // Compact uses ### headings
    const headingMatches = (output.match(/^### /gm) ?? []).length;
    expect(headingMatches).toBeLessThanOrEqual(3);
    expect(headingMatches).toBeGreaterThanOrEqual(1);

    expect(countTokens(output)).toBeLessThanOrEqual(2000);

    // Compact is shorter than full for same entries
    const fullOutput = formatForContext(entries8, 5000);
    expect(output.length).toBeLessThanOrEqual(fullOutput.length);
  });

  test("minimal tier (budget=800) — up to 2 entries", () => {
    const output = formatForContext(entries8, 800);
    expect(typeof output).toBe("string");

    // Minimal uses "- title: snippet" format
    const listLines = (output.match(/^- /gm) ?? []).length;
    expect(listLines).toBeLessThanOrEqual(2);
    expect(listLines).toBeGreaterThanOrEqual(1);

    expect(countTokens(output)).toBeLessThanOrEqual(800);
  });

  test("ultraMinimal tier (budget=500) — 1 entry, title + first sentence", () => {
    const output = formatForContext(entries8, 500);
    expect(typeof output).toBe("string");

    // Should contain the title of the first entry
    expect(output).toContain(entries8[0]!.title);

    expect(countTokens(output)).toBeLessThanOrEqual(500);
  });

  test("empty entries — returns 'No matching entries found.'", () => {
    const output5000 = formatForContext([], 5000);
    expect(output5000).toBe("No matching entries found.");

    const output800 = formatForContext([], 800);
    expect(output800).toBe("No matching entries found.");

    const output0 = formatForContext([], 0);
    expect(output0).toBe("No matching entries found.");
  });
});

// ---------------------------------------------------------------------------
// Ghost knowledge in formatted output
// ---------------------------------------------------------------------------

describe("ghost knowledge in formatted output", () => {
  test("ghost entry title appears in full tier output", () => {
    const entries = [ghostEntry, ...entries8.slice(0, 4)];
    const output = formatForContext(entries, 5000);
    expect(output).toContain(ghostEntry.title);
    expect(countTokens(output)).toBeLessThanOrEqual(5000);
  });

  test("ghost entry appears in ultraMinimal when it is the only entry", () => {
    const output = formatForContext([ghostEntry], 500);
    expect(output).toContain(ghostEntry.title);
    expect(countTokens(output)).toBeLessThanOrEqual(500);
  });

  test("ghost entry content appears in compact output", () => {
    const entries = [ghostEntry, makeEntry(1)];
    const output = formatForContext(entries, 2000);
    expect(output).toContain(ghostEntry.title);
    expect(countTokens(output)).toBeLessThanOrEqual(2000);
  });

  test("ghost entry first when passed first — preserved in output order", () => {
    const entries = [ghostEntry, ...entries8.slice(0, 4)];
    const output = formatForContext(entries, 5000);
    // Ghost title should appear before the second entry's title
    const ghostPos = output.indexOf(ghostEntry.title);
    const secondPos = output.indexOf(entries8[0]!.title);
    expect(ghostPos).toBeLessThan(secondPos);
  });
});

// ---------------------------------------------------------------------------
// Mixed-type ordering
// ---------------------------------------------------------------------------

describe("mixed-type ordering", () => {
  test("all 5 entry types present — no type filtering by formatForContext", () => {
    const mixedEntries: FormattableEntry[] = [
      makeEntry(0, "learning"),
      makeEntry(1, "error_pattern"),
      { ...ghostEntry, id: "ghost-mixed" },
      makeEntry(2, "convention"),
      makeEntry(3, "decision"),
    ];
    const output = formatForContext(mixedEntries, 5000);
    expect(output).toContain(mixedEntries[0]!.title);
    expect(output).toContain(mixedEntries[1]!.title);
    expect(output).toContain(mixedEntries[2]!.title);
    expect(output).toContain(mixedEntries[3]!.title);
    expect(output).toContain(mixedEntries[4]!.title);
    expect(countTokens(output)).toBeLessThanOrEqual(5000);
  });

  test("6 entries at full tier — only first 5 rendered", () => {
    const six = [...entries8.slice(0, 6)];
    const output = formatForContext(six, 5000);
    const headings = (output.match(/^## /gm) ?? []).length;
    expect(headings).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Budget edge cases
// ---------------------------------------------------------------------------

describe("budget edge cases", () => {
  test("budget=4999 → compact tier (< 5000)", () => {
    const output = formatForContext(entries8, 4999);
    const headings = (output.match(/^### /gm) ?? []).length;
    expect(headings).toBeLessThanOrEqual(3);
    expect(countTokens(output)).toBeLessThanOrEqual(4999);
  });

  test("budget=1999 → minimal tier (< 2000)", () => {
    const output = formatForContext(entries8, 1999);
    const listLines = (output.match(/^- /gm) ?? []).length;
    expect(listLines).toBeLessThanOrEqual(2);
  });

  test("budget=799 → ultraMinimal tier (< 800)", () => {
    const output = formatForContext(entries8, 799);
    expect(output).toContain(entries8[0]!.title);
    expect(countTokens(output)).toBeLessThanOrEqual(799);
  });

  test("budget=10000 → full tier, up to 5 entries", () => {
    const output = formatForContext(entries8, 10000);
    const headings = (output.match(/^## /gm) ?? []).length;
    expect(headings).toBeLessThanOrEqual(5);
    expect(headings).toBeGreaterThanOrEqual(1);
  });

  test("single entry at any budget level — does not throw", () => {
    const singleEntry = [makeEntry(0)];
    expect(() => formatForContext(singleEntry, 5000)).not.toThrow();
    expect(() => formatForContext(singleEntry, 2000)).not.toThrow();
    expect(() => formatForContext(singleEntry, 800)).not.toThrow();
    expect(() => formatForContext(singleEntry, 100)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Token counting accuracy
// ---------------------------------------------------------------------------

describe("token counting accuracy", () => {
  test("countTokens uses Math.ceil(chars/4) formula", () => {
    const text = "hello world"; // 11 chars → ceil(11/4) = 3
    expect(countTokens(text)).toBe(Math.ceil(11 / 4)); // 3
  });

  test("countTokens of empty string is 0", () => {
    expect(countTokens("")).toBe(0);
  });

  test("countTokens of 1000-char string is 250 (exact multiple)", () => {
    const text = "a".repeat(1000);
    expect(countTokens(text)).toBe(250); // ceil(1000/4) = 250
  });

  test("full-tier output of 8 entries fits within 5000 tokens", () => {
    const output = formatForContext(entries8, 5000);
    expect(countTokens(output)).toBeLessThanOrEqual(5000);
  });

  test("compact-tier output of 8 entries fits within 2000 tokens", () => {
    const output = formatForContext(entries8, 2000);
    expect(countTokens(output)).toBeLessThanOrEqual(2000);
  });
});
