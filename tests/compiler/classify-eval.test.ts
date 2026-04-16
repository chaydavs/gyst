import { test, expect } from "bun:test";
import {
  computeBloatScore,
  computeTypeMetrics,
  evaluateRows,
  loadFixture,
  openEvalDb,
  predictedTypeFromVerdict,
} from "../../src/compiler/classify-eval.js";
import type { Classification } from "../../src/compiler/classify-event.js";

function verdict(partial: Partial<Classification>): Classification {
  return {
    signalStrength: 0,
    scopeHint: "uncertain",
    candidateType: null,
    ruleIds: [],
    ...partial,
  };
}

test("predictedTypeFromVerdict respects 0.5 threshold", () => {
  expect(
    predictedTypeFromVerdict(verdict({ signalStrength: 0.49, candidateType: "convention" })),
  ).toBe(null);
  expect(
    predictedTypeFromVerdict(verdict({ signalStrength: 0.5, candidateType: "convention" })),
  ).toBe("convention");
  expect(
    predictedTypeFromVerdict(verdict({ signalStrength: 0.9, candidateType: null })),
  ).toBe(null);
});

test("loadFixture returns rows and filters by split", () => {
  const all = loadFixture("all");
  const test = loadFixture("test");
  expect(all.length).toBeGreaterThan(0);
  // All 30 adversarial rows are in the test split by design.
  expect(test.length).toBe(all.length);
});

test("evaluateRows runs full pipeline without throwing on an empty in-memory DB", () => {
  const rows = loadFixture("all");
  const db = openEvalDb(null);
  try {
    const outcomes = evaluateRows(db, rows);
    expect(outcomes.length).toBe(rows.length);
    // Every outcome has a well-formed verdict.
    for (const o of outcomes) {
      expect(typeof o.verdict.signalStrength).toBe("number");
      expect(Array.isArray(o.verdict.ruleIds)).toBe(true);
      expect(typeof o.correct).toBe("boolean");
    }
  } finally {
    db.close();
  }
});

test("bloat score is within target on the adversarial fixture", () => {
  const rows = loadFixture("all");
  const db = openEvalDb(null);
  try {
    const outcomes = evaluateRows(db, rows);
    const bloat = computeBloatScore(outcomes);
    // Regression gate. If this fails, the classifier started over-promoting.
    expect(bloat).toBeLessThanOrEqual(0.05);
  } finally {
    db.close();
  }
});

test("computeTypeMetrics handles the no-predictions edge case", () => {
  const m = computeTypeMetrics([], "convention");
  expect(m.tp).toBe(0);
  expect(m.precision).toBe(0);
  expect(m.f1).toBe(0);
});
