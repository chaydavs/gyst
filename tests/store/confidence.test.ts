/**
 * Tests for the confidence scoring function.
 *
 * Verifies source saturation, time decay, contradiction penalties,
 * code-change penalties, and edge cases.
 */

import { describe, test, expect } from "bun:test";
import { calculateConfidence } from "../../src/store/confidence.js";
import type { ConfidenceFactors } from "../../src/store/confidence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ConfidenceFactors object with sensible defaults and the
 * `now` fixed to a known date to make decay calculations deterministic.
 */
function makeFactors(overrides: Partial<ConfidenceFactors> = {}): ConfidenceFactors {
  const fixedNow = new Date("2025-01-01T00:00:00.000Z");
  return {
    type: "learning",
    sourceCount: 1,
    // Default: confirmed exactly at `now` → no decay
    lastConfirmedAt: fixedNow.toISOString(),
    now: fixedNow,
    hasContradiction: false,
    codeChanged: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Source saturation
// ---------------------------------------------------------------------------

describe("source saturation", () => {
  test("single source gives 0.5 base confidence (no decay, no penalties)", () => {
    const score = calculateConfidence(makeFactors({ sourceCount: 1 }));
    // saturation = 1 - 1/(1+1) = 0.5; decay = 1.0 (no time passed)
    expect(score).toBeCloseTo(0.5, 6);
  });

  test("two sources give approximately 0.667 base confidence", () => {
    const score = calculateConfidence(makeFactors({ sourceCount: 2 }));
    // saturation = 1 - 1/(1+2) ≈ 0.6667
    expect(score).toBeCloseTo(2 / 3, 4);
  });

  test("three sources give approximately 0.75 base confidence", () => {
    const score = calculateConfidence(makeFactors({ sourceCount: 3 }));
    // saturation = 1 - 1/(1+3) = 0.75
    expect(score).toBeCloseTo(0.75, 6);
  });

  test("nine sources give approximately 0.9 base confidence", () => {
    const score = calculateConfidence(makeFactors({ sourceCount: 9 }));
    // saturation = 1 - 1/(1+9) = 0.9
    expect(score).toBeCloseTo(0.9, 6);
  });

  test("zero sources gives 0 confidence", () => {
    const score = calculateConfidence(makeFactors({ sourceCount: 0 }));
    // saturation = 1 - 1/(1+0) = 0
    expect(score).toBeCloseTo(0, 6);
  });

  test("saturation approaches 1 as sources grow very large", () => {
    const score = calculateConfidence(makeFactors({ sourceCount: 999 }));
    expect(score).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// Time decay
// ---------------------------------------------------------------------------

describe("time decay", () => {
  test("no time elapsed means no decay (decay = 1.0)", () => {
    const fixedNow = new Date("2025-06-01T00:00:00.000Z");
    const score = calculateConfidence(
      makeFactors({
        lastConfirmedAt: fixedNow.toISOString(),
        now: fixedNow,
        sourceCount: 1,
      }),
    );
    // decay = 0.5^(0/halfLife) = 1.0; score = 0.5
    expect(score).toBeCloseTo(0.5, 6);
  });

  test("error_pattern decays to half after 30 days", () => {
    const lastConfirmed = new Date("2025-01-01T00:00:00.000Z");
    const now = new Date("2025-01-31T00:00:00.000Z"); // 30 days later
    const score = calculateConfidence({
      type: "error_pattern",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    // saturation=0.5, decay=0.5^(30/30)=0.5 → 0.5*0.5=0.25
    expect(score).toBeCloseTo(0.25, 4);
  });

  test("convention type barely decays over 365 days (half-life 9999)", () => {
    const lastConfirmed = new Date("2024-01-01T00:00:00.000Z");
    const now = new Date("2025-01-01T00:00:00.000Z"); // 365 days later
    const score = calculateConfidence({
      type: "convention",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    // decay = 0.5^(365/9999) ≈ 0.9747 — almost no decay
    expect(score).toBeGreaterThan(0.48);
    // Still much less than 365-day half-life type (decision at 0.5^1 = 0.25 * 0.5)
  });

  test("decision type half-life is 365 days", () => {
    const lastConfirmed = new Date("2024-01-01T00:00:00.000Z");
    const now = new Date("2025-01-01T00:00:00.000Z"); // ~365 days later
    const score = calculateConfidence({
      type: "decision",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    // saturation=0.5, decay=0.5^(365/365)≈0.5 → score≈0.25
    expect(score).toBeCloseTo(0.25, 2);
  });

  test("learning type half-life is 60 days", () => {
    const lastConfirmed = new Date("2025-01-01T00:00:00.000Z");
    const now = new Date("2025-03-02T00:00:00.000Z"); // 60 days later
    const score = calculateConfidence({
      type: "learning",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    // saturation=0.5, decay=0.5^(60/60)=0.5 → score=0.25
    expect(score).toBeCloseTo(0.25, 2);
  });

  test("unknown type falls back to learning half-life (60 days)", () => {
    const lastConfirmed = new Date("2025-01-01T00:00:00.000Z");
    const now = new Date("2025-03-02T00:00:00.000Z"); // 60 days later
    const learningScore = calculateConfidence({
      type: "learning",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    const unknownScore = calculateConfidence({
      type: "unknown_type",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    expect(unknownScore).toBeCloseTo(learningScore, 6);
  });

  test("future lastConfirmedAt is treated as zero days elapsed", () => {
    const fixedNow = new Date("2025-01-01T00:00:00.000Z");
    const future = new Date("2025-06-01T00:00:00.000Z"); // 5 months in the future
    const score = calculateConfidence({
      type: "learning",
      sourceCount: 1,
      lastConfirmedAt: future.toISOString(),
      now: fixedNow,
      hasContradiction: false,
      codeChanged: false,
    });
    // effectiveDays = max(0, negative) = 0 → decay = 1.0 → score = 0.5
    expect(score).toBeCloseTo(0.5, 6);
  });

  test("very old entry (365+ days for error_pattern) approaches 0", () => {
    const lastConfirmed = new Date("2024-01-01T00:00:00.000Z");
    const now = new Date("2025-01-01T00:00:00.000Z"); // 365 days later
    const score = calculateConfidence({
      type: "error_pattern",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: false,
      codeChanged: false,
    });
    // 365 / 30 ≈ 12.17 half-lives → decay ≈ 0.5^12.17 ≈ 0.000219
    // score ≈ 0.5 * 0.000219 ≈ 0.000109
    expect(score).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------

describe("contradiction penalty", () => {
  test("contradiction halves the confidence score", () => {
    const without = calculateConfidence(makeFactors({ hasContradiction: false }));
    const with_ = calculateConfidence(makeFactors({ hasContradiction: true }));
    expect(with_).toBeCloseTo(without * 0.5, 6);
  });

  test("contradiction penalty is applied multiplicatively", () => {
    const score = calculateConfidence(
      makeFactors({
        sourceCount: 3,
        hasContradiction: true,
        codeChanged: false,
      }),
    );
    // saturation=0.75, decay=1.0, contradiction*0.5 → 0.375
    expect(score).toBeCloseTo(0.375, 6);
  });
});

describe("code-change penalty", () => {
  test("codeChanged reduces confidence by 30% (multiplied by 0.7)", () => {
    const without = calculateConfidence(makeFactors({ codeChanged: false }));
    const with_ = calculateConfidence(makeFactors({ codeChanged: true }));
    expect(with_).toBeCloseTo(without * 0.7, 6);
  });

  test("code change penalty is applied multiplicatively after contradiction", () => {
    const score = calculateConfidence(
      makeFactors({
        sourceCount: 1,
        hasContradiction: true,
        codeChanged: true,
      }),
    );
    // saturation=0.5, decay=1.0 → 0.5 * 0.5 (contradiction) * 0.7 (code) = 0.175
    expect(score).toBeCloseTo(0.175, 6);
  });
});

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("result clamping", () => {
  test("confidence never exceeds 1.0", () => {
    // Construct a scenario that could theoretically push above 1
    const score = calculateConfidence(
      makeFactors({ sourceCount: 99999, hasContradiction: false, codeChanged: false }),
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test("confidence never goes below 0.0", () => {
    const score = calculateConfidence(
      makeFactors({ sourceCount: 0, hasContradiction: true, codeChanged: true }),
    );
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  test("zero sources with both penalties still returns 0.0", () => {
    const score = calculateConfidence(
      makeFactors({ sourceCount: 0, hasContradiction: true, codeChanged: true }),
    );
    expect(score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios
// ---------------------------------------------------------------------------

describe("combined factor scenarios", () => {
  test("high source count + no decay + no penalties approaches 1.0", () => {
    const score = calculateConfidence(
      makeFactors({
        type: "convention",
        sourceCount: 99,
        hasContradiction: false,
        codeChanged: false,
      }),
    );
    // saturation ≈ 0.99, decay ≈ 1.0 (convention half-life 9999d, 0 days elapsed)
    expect(score).toBeGreaterThan(0.98);
  });

  test("old error_pattern with contradiction and code change gives very low score", () => {
    const lastConfirmed = new Date("2024-01-01T00:00:00.000Z");
    const now = new Date("2025-01-01T00:00:00.000Z");
    const score = calculateConfidence({
      type: "error_pattern",
      sourceCount: 1,
      lastConfirmedAt: lastConfirmed.toISOString(),
      now,
      hasContradiction: true,
      codeChanged: true,
    });
    // Already near-zero due to time decay, then further penalised
    expect(score).toBeLessThan(0.001);
  });

  test("fresh convention with many sources gives high confidence", () => {
    const score = calculateConfidence(
      makeFactors({
        type: "convention",
        sourceCount: 10,
        hasContradiction: false,
        codeChanged: false,
      }),
    );
    // saturation = 1 - 1/11 ≈ 0.909; decay ≈ 1.0
    expect(score).toBeGreaterThan(0.9);
  });

  test("returns a number in [0, 1] for arbitrary valid inputs", () => {
    const inputs: Array<Partial<ConfidenceFactors>> = [
      { type: "error_pattern", sourceCount: 5, hasContradiction: true, codeChanged: false },
      { type: "convention", sourceCount: 1, hasContradiction: false, codeChanged: true },
      { type: "decision", sourceCount: 2, hasContradiction: true, codeChanged: true },
      { type: "learning", sourceCount: 0, hasContradiction: false, codeChanged: false },
    ];

    for (const input of inputs) {
      const score = calculateConfidence(makeFactors(input));
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });
});
