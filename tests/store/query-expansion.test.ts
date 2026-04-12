/**
 * Unit tests for the query expansion module.
 *
 * Covers:
 *  - Pass-through when no synonyms match
 *  - OR-group emission for recognised keywords
 *  - Stop-word / FTS5-problem-word removal
 *  - Case-insensitive matching
 *  - Empty string input
 *  - isReasoningQuery helper
 */

import { describe, test, expect } from "bun:test";
import { expandQuery, isReasoningQuery } from "../../src/store/query-expansion.js";

// ---------------------------------------------------------------------------
// expandQuery
// ---------------------------------------------------------------------------

describe("expandQuery", () => {
  test("returns original words when no synonyms match", () => {
    const result = expandQuery("stripe webhook signature verification");
    expect(result).toBe("stripe webhook signature verification");
  });

  test("adds OR synonym group for 'choose'", () => {
    const result = expandQuery("choose bun runtime");
    // "choose" should emit an OR group containing the synonym "chose"
    expect(result).toContain("(choose OR chose)");
    // Original context words should be preserved
    expect(result).toContain("bun");
    expect(result).toContain("runtime");
  });

  test("adds OR synonym group for 'chose'", () => {
    const result = expandQuery("why chose sqlite");
    expect(result).toContain("(chose OR choose)");
    expect(result).toContain("sqlite");
  });

  test("preserves original word in the OR group alongside its synonym", () => {
    const result = expandQuery("choose postgres");
    // Original "choose" must be one of the OR alternatives
    expect(result).toContain("choose");
    // Synonym "chose" must also be present
    expect(result).toContain("chose");
    // "postgres" should expand to include "postgresql"
    expect(result).toContain("(postgres OR postgresql)");
  });

  test("is case insensitive — uppercase query produces same expansion", () => {
    const lower = expandQuery("choose bun");
    const upper = expandQuery("CHOOSE BUN");
    expect(lower).toBe(upper);
  });

  test("handles empty string without throwing", () => {
    const result = expandQuery("");
    expect(result).toBe("");
  });

  test("strips FTS5 problem word 'did' from query", () => {
    const result = expandQuery("why did we choose bun");
    expect(result).not.toContain("did");
    expect(result).not.toContain("we");
    expect(result).toContain("why");
    expect(result).toContain("bun");
  });

  test("strips FTS5 NOT operator word 'not' to prevent false exclusions", () => {
    const result = expandQuery("tests failing open handles process not exit");
    expect(result).not.toContain(" not ");
    expect(result).toContain("exit");
  });

  test("expands 'failing' to include 'leaking' as OR alternative", () => {
    const result = expandQuery("tests failing open handles");
    expect(result).toContain("(failing OR leaking)");
    expect(result).toContain("tests");
    expect(result).toContain("open");
    expect(result).toContain("handles");
  });

  test("expands 'duplicate' to include 'constraint'", () => {
    const result = expandQuery("unique constraint failed database insert duplicate");
    expect(result).toContain("(duplicate OR constraint)");
  });

  test("expands 'reranker' to include 'ranker'", () => {
    const result = expandQuery("reciprocal rank fusion instead of reranker");
    expect(result).toContain("(reranker OR ranker)");
  });

  test("strips common stop words that rarely appear in entry text", () => {
    const result = expandQuery("how should we handle api errors");
    expect(result).not.toContain(" we ");
    // "how" and "should" are not stop words — they remain
    expect(result).toContain("how");
    expect(result).toContain("should");
    expect(result).toContain("handle");
    expect(result).toContain("api");
    expect(result).toContain("errors");
  });

  test("handles query with only stop words gracefully", () => {
    const result = expandQuery("did we not");
    // All words are problem words; result should be empty or whitespace-only
    expect(result.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isReasoningQuery
// ---------------------------------------------------------------------------

describe("isReasoningQuery", () => {
  test("returns true for 'why' queries", () => {
    expect(isReasoningQuery("why did we choose bun over node")).toBe(true);
  });

  test("returns true for 'chose' queries", () => {
    expect(isReasoningQuery("we chose sqlite over postgres")).toBe(true);
  });

  test("returns true for 'decision' queries", () => {
    expect(isReasoningQuery("decision to use jwt over sessions")).toBe(true);
  });

  test("returns false for non-reasoning queries", () => {
    expect(isReasoningQuery("stripe webhook signature verification failing")).toBe(false);
  });

  test("is case insensitive", () => {
    expect(isReasoningQuery("WHY use reciprocal rank fusion")).toBe(true);
  });
});
