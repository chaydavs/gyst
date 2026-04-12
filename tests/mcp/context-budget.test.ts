/**
 * Tests for formatForContext and its tier formatters.
 *
 * Exercises tier selection, token budget enforcement, edge cases, and
 * ranking preservation. Uses synthetic FormattableEntry objects — no DB.
 */

import { describe, test, expect } from "bun:test";
import {
  formatForContext,
  formatFull,
  formatCompact,
  formatMinimal,
  formatUltraMinimal,
} from "../../src/utils/format-recall.js";
import { countTokens } from "../../src/utils/tokens.js";
import type { FormattableEntry } from "../../src/utils/format-recall.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a FormattableEntry with predictable content for testing. */
function makeEntry(
  overrides: Partial<FormattableEntry> & { id: string },
): FormattableEntry {
  return {
    type: "convention",
    title: `Entry ${overrides.id}`,
    content: "Default short content sentence. Second sentence here.",
    confidence: 0.8,
    files: [],
    tags: [],
    ...overrides,
  };
}

/** Generates a string of approximately `charCount` characters. */
function longContent(charCount: number): string {
  const sentence = "This is a long content sentence that keeps repeating. ";
  return sentence.repeat(Math.ceil(charCount / sentence.length)).slice(0, charCount);
}

const SHORT_ENTRIES: readonly FormattableEntry[] = [
  makeEntry({ id: "a", title: "Alpha entry", confidence: 0.9 }),
  makeEntry({ id: "b", title: "Beta entry", confidence: 0.7 }),
  makeEntry({ id: "c", title: "Gamma entry", confidence: 0.6 }),
  makeEntry({ id: "d", title: "Delta entry", confidence: 0.5 }),
  makeEntry({ id: "e", title: "Epsilon entry", confidence: 0.4 }),
  makeEntry({ id: "f", title: "Zeta entry", confidence: 0.3 }),
];

// ---------------------------------------------------------------------------
// Tier selection tests
// ---------------------------------------------------------------------------

describe("formatForContext", () => {
  describe("tier selection", () => {
    test("budget=5000 uses formatFull and returns up to 5 entries", () => {
      const result = formatForContext(SHORT_ENTRIES, 5000);
      // Full format uses ## heading
      expect(result).toContain("## Alpha entry");
      // Only first 5 entries should appear
      expect(result).toContain("## Epsilon entry");
      expect(result).not.toContain("## Zeta entry");
    });

    test("budget=3000 uses formatCompact and returns up to 3 entries", () => {
      const result = formatForContext(SHORT_ENTRIES, 3000);
      // Compact format uses ### heading
      expect(result).toContain("### Alpha entry");
      expect(result).toContain("### Beta entry");
      expect(result).toContain("### Gamma entry");
      expect(result).not.toContain("### Delta entry");
    });

    test("budget=1500 uses formatMinimal and returns up to 2 entries", () => {
      const result = formatForContext(SHORT_ENTRIES, 1500);
      // Minimal format uses bullet list
      expect(result).toContain("- Alpha entry:");
      expect(result).toContain("- Beta entry:");
      expect(result).not.toContain("- Gamma entry:");
    });

    test("budget=500 uses formatUltraMinimal and returns 1 entry", () => {
      const result = formatForContext(SHORT_ENTRIES, 500);
      // Ultra-minimal: just title and first sentence, no ## or ### or -
      expect(result).toContain("Alpha entry");
      expect(result).not.toContain("Beta entry");
    });

    test("budget=10000 (oversized) still uses formatFull capped at 5 entries", () => {
      const result = formatForContext(SHORT_ENTRIES, 10000);
      expect(result).toContain("## Alpha entry");
      expect(result).toContain("## Epsilon entry");
      // 6th entry must not appear
      expect(result).not.toContain("## Zeta entry");
    });

    test("budget=5000 boundary uses formatFull", () => {
      const result = formatForContext(SHORT_ENTRIES, 5000);
      expect(result).toContain("## Alpha entry");
    });

    test("budget=2000 boundary uses formatCompact", () => {
      const result = formatForContext(SHORT_ENTRIES, 2000);
      expect(result).toContain("### Alpha entry");
    });

    test("budget=800 boundary uses formatMinimal", () => {
      const result = formatForContext(SHORT_ENTRIES, 800);
      expect(result).toContain("- Alpha entry:");
    });

    test("budget=799 uses formatUltraMinimal", () => {
      const result = formatForContext(SHORT_ENTRIES, 799);
      expect(result).not.toContain("##");
      expect(result).not.toContain("###");
      expect(result).not.toContain("-");
      expect(result).toContain("Alpha entry");
    });
  });

  // ---------------------------------------------------------------------------
  // Token budget enforcement tests
  // ---------------------------------------------------------------------------

  describe("token budget enforcement", () => {
    test("formatFull output fits within budget for long entries", () => {
      const entries = SHORT_ENTRIES.slice(0, 5).map((e) => ({
        ...e,
        content: longContent(2000),
      }));
      const budget = 5000;
      const result = formatForContext(entries, budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
      // Top entry title must still be present
      expect(result).toContain("Alpha entry");
    });

    test("formatCompact output fits within budget for long entries", () => {
      const entries = SHORT_ENTRIES.slice(0, 3).map((e) => ({
        ...e,
        content: longContent(2000),
      }));
      const budget = 3000;
      const result = formatForContext(entries, budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
      expect(result).toContain("Alpha entry");
    });

    test("formatMinimal output fits within budget for long entries", () => {
      const entries = SHORT_ENTRIES.slice(0, 2).map((e) => ({
        ...e,
        content: longContent(2000),
      }));
      const budget = 1500;
      const result = formatForContext(entries, budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
      expect(result).toContain("Alpha entry");
    });

    test("formatUltraMinimal output fits within budget for long entry", () => {
      const entry = { ...SHORT_ENTRIES[0]!, content: longContent(2000) };
      const budget = 500;
      const result = formatForContext([entry], budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
      expect(result).toContain("Alpha entry");
    });

    test("formatFull enforces budget with very tight constraint", () => {
      const entries = SHORT_ENTRIES.slice(0, 5).map((e) => ({
        ...e,
        content: longContent(5000),
      }));
      const budget = 6000;
      const result = formatFull(entries, budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
    });

    test("formatCompact enforces budget with very tight constraint", () => {
      const entries = SHORT_ENTRIES.slice(0, 3).map((e) => ({
        ...e,
        content: longContent(5000),
      }));
      const budget = 2500;
      const result = formatCompact(entries, budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case tests
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    test("empty entries array returns 'No matching entries found.'", () => {
      const result = formatForContext([], 5000);
      expect(result).toBe("No matching entries found.");
    });

    test("single entry with tiny budget (200) returns title + first sentence within budget", () => {
      const entry = makeEntry({
        id: "tiny",
        title: "Short title",
        content: "First sentence ends here. Second sentence never included.",
        confidence: 0.9,
      });
      const budget = 200;
      const result = formatForContext([entry], budget);
      expect(countTokens(result)).toBeLessThanOrEqual(budget);
      expect(result).toContain("Short title");
    });

    test("error_pattern type in compact mode includes Fix line when content mentions fix", () => {
      const entry: FormattableEntry = {
        id: "err-1",
        type: "error_pattern",
        title: "Null pointer dereference",
        content: "This error occurs when accessing a null object. Fix: use optional chaining (?.) before property access.",
        confidence: 0.85,
        files: [],
        tags: [],
      };
      const result = formatCompact([entry], 3000);
      // The fix sentence should appear
      expect(result).toContain("Fix:");
    });

    test("non-error_pattern type in compact mode omits Fix line logic", () => {
      const entry: FormattableEntry = {
        id: "conv-1",
        type: "convention",
        title: "Use strict mode",
        content: "Always enable TypeScript strict mode. Fix: add strict to tsconfig.",
        confidence: 0.85,
        files: [],
        tags: [],
      };
      // For non-error_pattern, the fix extraction is skipped; but the content
      // still appears in the first 2 sentences, so this just verifies no crash.
      const result = formatCompact([entry], 3000);
      expect(result).toContain("Use strict mode");
    });

    test("formatFull includes files and tags when present", () => {
      const entry: FormattableEntry = {
        id: "meta-1",
        type: "convention",
        title: "Entry with metadata",
        content: "Content with metadata attached.",
        confidence: 0.7,
        files: ["src/a.ts", "src/b.ts"],
        tags: ["typescript", "testing"],
      };
      const result = formatFull([entry], 5000);
      expect(result).toContain("Files: src/a.ts, src/b.ts");
      expect(result).toContain("Tags: typescript, testing");
    });

    test("formatFull omits files line when files array is empty", () => {
      const entry: FormattableEntry = {
        id: "no-files",
        type: "learning",
        title: "No files entry",
        content: "This entry has no associated files.",
        confidence: 0.6,
        files: [],
        tags: [],
      };
      const result = formatFull([entry], 5000);
      expect(result).not.toContain("Files:");
      expect(result).not.toContain("Tags:");
    });

    test("formatFull omits files line when files is undefined", () => {
      const entry: FormattableEntry = {
        id: "undef-files",
        type: "decision",
        title: "Decision entry",
        content: "We decided to use Bun for its performance benefits.",
        confidence: 0.9,
      };
      const result = formatFull([entry], 5000);
      expect(result).not.toContain("Files:");
    });

    test("formatMinimal truncates content to approximately 80 chars", () => {
      const longText = "A".repeat(200);
      const entry = makeEntry({ id: "long", title: "Long content", content: longText });
      const result = formatMinimal([entry], 1500);
      // The snippet should be at most 80 chars of content
      const line = result.split("\n")[0]!;
      // Line format: "- Long content: AAA..."
      const contentPart = line.replace("- Long content: ", "");
      expect(contentPart.length).toBeLessThanOrEqual(80);
    });
  });

  // ---------------------------------------------------------------------------
  // Ranking preservation tests
  // ---------------------------------------------------------------------------

  describe("ranking preservation", () => {
    test("formatFull preserves ranking order (high-conf first)", () => {
      const entries: readonly FormattableEntry[] = [
        makeEntry({ id: "high", title: "High confidence", confidence: 0.95 }),
        makeEntry({ id: "mid", title: "Mid confidence", confidence: 0.7 }),
        makeEntry({ id: "low", title: "Low confidence", confidence: 0.4 }),
      ];
      const result = formatFull(entries, 5000);
      const highIdx = result.indexOf("High confidence");
      const midIdx = result.indexOf("Mid confidence");
      const lowIdx = result.indexOf("Low confidence");
      expect(highIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(lowIdx);
    });

    test("formatCompact preserves ranking order (high-conf first)", () => {
      const entries: readonly FormattableEntry[] = [
        makeEntry({ id: "high", title: "High confidence", confidence: 0.95 }),
        makeEntry({ id: "mid", title: "Mid confidence", confidence: 0.7 }),
        makeEntry({ id: "low", title: "Low confidence", confidence: 0.4 }),
      ];
      const result = formatCompact(entries, 3000);
      const highIdx = result.indexOf("High confidence");
      const midIdx = result.indexOf("Mid confidence");
      expect(highIdx).toBeLessThan(midIdx);
    });

    test("formatMinimal preserves ranking order (high-conf first)", () => {
      const entries: readonly FormattableEntry[] = [
        makeEntry({ id: "high", title: "High confidence", confidence: 0.95 }),
        makeEntry({ id: "mid", title: "Mid confidence", confidence: 0.7 }),
      ];
      const result = formatMinimal(entries, 1500);
      const highIdx = result.indexOf("High confidence");
      const midIdx = result.indexOf("Mid confidence");
      expect(highIdx).toBeLessThan(midIdx);
    });

    test("formatForContext at budget=3000 top entry appears first in compact output", () => {
      const entries: readonly FormattableEntry[] = [
        makeEntry({ id: "first", title: "First ranked", confidence: 0.9 }),
        makeEntry({ id: "second", title: "Second ranked", confidence: 0.5 }),
        makeEntry({ id: "third", title: "Third ranked", confidence: 0.2 }),
      ];
      const result = formatForContext(entries, 3000);
      const firstIdx = result.indexOf("First ranked");
      const secondIdx = result.indexOf("Second ranked");
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    test("formatForContext at budget=500 returns only the first (top) entry", () => {
      const entries: readonly FormattableEntry[] = [
        makeEntry({ id: "top", title: "Top entry", confidence: 0.9 }),
        makeEntry({ id: "bottom", title: "Bottom entry", confidence: 0.1 }),
      ];
      const result = formatForContext(entries, 500);
      expect(result).toContain("Top entry");
      expect(result).not.toContain("Bottom entry");
    });
  });
});
