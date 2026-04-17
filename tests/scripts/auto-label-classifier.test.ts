/**
 * Tests for the LLM-assisted fixture labeller.
 *
 * The network call is stubbed via the `fetchFn` injection — real API keys
 * are never used. We exercise:
 *   - Prompt-builder produces text that mentions the event payload.
 *   - applyAutoLabel() correctly translates the "null" string → null type.
 *   - labelRow() is fail-soft on network errors, schema mismatches, and
 *     malformed JSON — always returning a schema-valid placeholder.
 */

import { describe, test, expect } from "bun:test";
import {
  buildPrompt,
  applyAutoLabel,
  labelRow,
  AutoLabelResponseSchema,
} from "../../scripts/auto-label-classifier.js";
import { LabelRowSchema } from "../../src/compiler/classifier-eval-schema.js";

function makeRow() {
  return {
    id: "real-00042",
    event_type: "prompt" as const,
    payload: { text: "we always use camelCase for function names" },
    expected: {
      candidateType: null,
      scopeHint: "uncertain" as const,
    },
    split: "train" as const,
    source: "real" as const,
  };
}

function stubResponse(text: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

describe("auto-label-classifier", () => {
  test("buildPrompt includes payload text and type menu", () => {
    const prompt = buildPrompt(makeRow());
    expect(prompt).toContain("camelCase");
    expect(prompt).toContain("convention");
    expect(prompt).toContain("error_pattern");
    expect(prompt).toContain("subcategory");
  });

  test('applyAutoLabel maps "null" string → null candidateType', () => {
    const row = makeRow();
    const result = applyAutoLabel(row, {
      candidateType: "null",
      scopeHint: "uncertain",
      reasoning: "filler question",
    });
    expect(result.expected.candidateType).toBeNull();
    expect(result.expected.scopeHint).toBe("uncertain");
    // schema validates
    expect(() => LabelRowSchema.parse(result)).not.toThrow();
  });

  test("applyAutoLabel keeps subcategory only when candidateType is set", () => {
    const row = makeRow();
    const withType = applyAutoLabel(row, {
      candidateType: "convention",
      scopeHint: "team",
      subcategory: "naming",
      reasoning: "team-wide naming rule",
    });
    expect(withType.expected).toEqual({
      candidateType: "convention",
      scopeHint: "team",
      subcategory: "naming",
    });

    const withoutType = applyAutoLabel(row, {
      candidateType: "null",
      scopeHint: "uncertain",
      subcategory: "should-be-dropped",
      reasoning: "filler",
    });
    expect(withoutType.expected).toEqual({
      candidateType: null,
      scopeHint: "uncertain",
    });
  });

  test("labelRow produces schema-valid output for a well-formed response", async () => {
    const haikuJson = JSON.stringify({
      candidateType: "convention",
      scopeHint: "team",
      subcategory: "naming",
      reasoning: "unambiguous team rule",
    });
    const result = await labelRow(makeRow(), {
      apiKey: "sk-test",
      fetchFn: stubResponse(haikuJson),
    });
    expect(LabelRowSchema.parse(result)).toBeDefined();
    expect(result.expected.candidateType).toBe("convention");
    expect(result.notes?.startsWith("auto-labelled")).toBe(true);
  });

  test("labelRow is fail-soft on schema mismatch (unknown candidateType)", async () => {
    const badJson = JSON.stringify({
      candidateType: "bogus",
      scopeHint: "team",
      reasoning: "garbage",
    });
    const result = await labelRow(makeRow(), {
      apiKey: "sk-test",
      fetchFn: stubResponse(badJson),
    });
    expect(result.expected.candidateType).toBeNull();
    expect(result.notes).toContain("schema mismatch");
    expect(LabelRowSchema.parse(result)).toBeDefined();
  });

  test("labelRow is fail-soft on network error", async () => {
    const failingFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await labelRow(makeRow(), {
      apiKey: "sk-test",
      fetchFn: failingFetch,
    });
    expect(result.expected.candidateType).toBeNull();
    expect(result.notes).toContain("auto-label failed");
    expect(result.notes).toContain("ECONNREFUSED");
  });

  test("labelRow is fail-soft on malformed JSON from Haiku", async () => {
    const result = await labelRow(makeRow(), {
      apiKey: "sk-test",
      fetchFn: stubResponse("not json at all { {"),
    });
    expect(result.expected.candidateType).toBeNull();
    expect(result.notes).toContain("auto-label failed");
  });

  test("AutoLabelResponseSchema rejects invalid scopeHint", () => {
    const result = AutoLabelResponseSchema.safeParse({
      candidateType: "convention",
      scopeHint: "invalid",
      reasoning: "x",
    });
    expect(result.success).toBe(false);
  });
});
