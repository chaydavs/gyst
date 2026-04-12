#!/usr/bin/env bun
/**
 * compare-eval.ts
 *
 * Compares the current eval run against a saved baseline and exits non-zero
 * if any metric regresses beyond the allowed tolerance.
 *
 * Usage:
 *   bun run scripts/compare-eval.ts
 *
 * Exit codes:
 *   0 — all metrics within tolerance and MRR@5 >= 0.5
 *   1 — regression detected
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const RESULTS_PATH = resolve(__dirname, "../tests/eval/results.json");
const BASELINE_PATH = resolve(__dirname, "../tests/eval/baseline.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Maximum allowed drop in any metric before flagging a regression. */
const REGRESSION_TOLERANCE = 0.05;

/** Absolute minimum acceptable MRR@5 regardless of baseline. */
const MRR_FLOOR = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalSummary {
  readonly timestamp: string;
  readonly totalQueries: number;
  readonly mrr: number;
  readonly meanPrecision: number;
  readonly meanRecall: number;
  readonly meanNdcg: number;
  readonly hitRate: number;
}

interface MetricComparison {
  readonly name: string;
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
  readonly regressed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(path: string): EvalSummary {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as EvalSummary;
  } catch (err) {
    console.error(`Failed to read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function compareMetric(
  name: string,
  baseline: number,
  current: number,
): MetricComparison {
  const delta = current - baseline;
  const regressed = delta < -REGRESSION_TOLERANCE;
  return { name, baseline, current, delta, regressed };
}

function formatDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(4)}`;
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("\n  Gyst Eval Comparison");
  console.log("  ====================\n");

  const current = readJson(RESULTS_PATH);
  const baseline = readJson(BASELINE_PATH);

  console.log(`  Baseline : ${baseline.timestamp}`);
  console.log(`  Current  : ${current.timestamp}`);
  console.log(`  Queries  : ${current.totalQueries} (baseline: ${baseline.totalQueries})\n`);

  const comparisons: MetricComparison[] = [
    compareMetric("MRR@5", baseline.mrr, current.mrr),
    compareMetric("Precision@5", baseline.meanPrecision, current.meanPrecision),
    compareMetric("Recall@5", baseline.meanRecall, current.meanRecall),
    compareMetric("NDCG@5", baseline.meanNdcg, current.meanNdcg),
  ];

  // Check MRR floor independently of baseline
  const mrrBelowFloor = current.mrr < MRR_FLOOR;

  // ---------------------------------------------------------------------------
  // Render comparison table
  // ---------------------------------------------------------------------------

  const COL_NAME = 12;
  const COL_VAL = 8;
  const COL_DELTA = 9;
  const COL_STATUS = 10;

  const separator =
    "+" +
    "-".repeat(COL_NAME + 2) +
    "+" +
    "-".repeat(COL_VAL + 2) +
    "+" +
    "-".repeat(COL_VAL + 2) +
    "+" +
    "-".repeat(COL_DELTA + 2) +
    "+" +
    "-".repeat(COL_STATUS + 2) +
    "+";

  const header =
    "| " +
    padRight("Metric", COL_NAME) +
    " | " +
    padRight("Baseline", COL_VAL) +
    " | " +
    padRight("Current", COL_VAL) +
    " | " +
    padRight("Delta", COL_DELTA) +
    " | " +
    padRight("Status", COL_STATUS) +
    " |";

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const c of comparisons) {
    const status = c.regressed ? "REGRESSED" : "OK";
    const row =
      "| " +
      padRight(c.name, COL_NAME) +
      " | " +
      padLeft(c.baseline.toFixed(4), COL_VAL) +
      " | " +
      padLeft(c.current.toFixed(4), COL_VAL) +
      " | " +
      padLeft(formatDelta(c.delta), COL_DELTA) +
      " | " +
      padRight(status, COL_STATUS) +
      " |";
    console.log(row);
  }

  console.log(separator);
  console.log("");

  // ---------------------------------------------------------------------------
  // Summarise
  // ---------------------------------------------------------------------------

  const regressedMetrics = comparisons.filter((c) => c.regressed);
  const hasRegression = regressedMetrics.length > 0 || mrrBelowFloor;

  if (mrrBelowFloor) {
    console.error(
      `  FAIL: MRR@5 = ${current.mrr.toFixed(4)} is below the absolute floor of ${MRR_FLOOR}.\n`,
    );
  }

  if (regressedMetrics.length > 0) {
    console.error(`  FAIL: ${regressedMetrics.length} metric(s) regressed beyond tolerance (${REGRESSION_TOLERANCE}):`);
    for (const c of regressedMetrics) {
      console.error(
        `    ${c.name}: ${c.baseline.toFixed(4)} → ${c.current.toFixed(4)} (${formatDelta(c.delta)})`,
      );
    }
    console.error("");
  }

  if (!hasRegression) {
    console.log(`  PASS: All metrics within tolerance (${REGRESSION_TOLERANCE}) and MRR@5 >= ${MRR_FLOOR}.\n`);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
