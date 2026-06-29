/**
 * H3 — strip question-words / pronouns / auxiliaries before FTS5 MATCH.
 *
 * FTS5_PROBLEM_WORDS removed "is/the/of" but kept "what/which/my/have", which
 * inflate the implicit-AND burden (and add noise to the H2 OR-fallback). These
 * words almost never appear verbatim in the answer text, so dropping them
 * raises precision and trims the retrieved-context token cost without losing
 * the content terms. Synonym OR-groups must still be emitted unchanged.
 *
 * expandQuery receives an already-tokenised, lowercased expression (the real
 * pipeline runs codeTokenize → escapeFts5 → expandQuery).
 */
import { describe, test, expect } from "bun:test";
import { expandQuery } from "../../src/store/query-expansion.js";

describe("expandQuery stop-word expansion (H3)", () => {
  test("drops question words and pronouns, keeps content terms", () => {
    // what, is, the, of, my → dropped; name, dog → kept
    expect(expandQuery("what is the name of my dog")).toBe("name dog");
  });

  test("drops auxiliaries and first-person pronoun", () => {
    // how, have, i, been → dropped; long, collecting, cameras → kept
    expect(expandQuery("how long have i been collecting cameras")).toBe(
      "long collecting cameras",
    );
  });

  test("still emits synonym OR-groups for surviving content terms", () => {
    // why, did, we → dropped; choose → (choose OR chose); bun → kept
    const out = expandQuery("why did we choose bun");
    expect(out).toContain("(choose OR chose)");
    expect(out).toContain("bun");
    expect(out).not.toContain("why");
    expect(out).not.toContain("we ");
  });

  test("does not strip ordinary content words", () => {
    expect(expandQuery("recreational volleyball league record")).toBe(
      "recreational volleyball league record",
    );
  });
});
