#!/usr/bin/env bun
/**
 * Offline eval harness for the classifier.
 *
 * Consumes tests/fixtures/classifier-eval/labels.jsonl, runs every row
 * through Stage 1 (classify-event) + optional Stage 2 (graphify rerank),
 * and emits:
 *   - Per-type precision/recall/F1
 *   - Confusion matrix (expected × predicted)
 *   - Bloat score = (#created − #expected_positives) / #rows
 *   - Top mis-classifications with rule IDs surfaced
 *
 * Stage 3 (LLM distill) is intentionally off — we need determinism in CI.
 *
 * Usage:
 *   bun run src/compiler/classify-eval.ts             # stage 1 only (in-memory empty DB)
 *   bun run src/compiler/classify-eval.ts --db .gyst/wiki.db  # stage 1+2 vs your real KB
 *   bun run src/compiler/classify-eval.ts --split test        # eval only the test split
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyEvent,
  type Classification,
  type EntryType,
} from "./classify-event.js";
import { rerankWithGraphify } from "./classify-rerank.js";
import { initDatabase } from "../store/database.js";
import {
  LabelRowSchema,
  type LabelRow,
  CANDIDATE_TYPES,
} from "./classifier-eval-schema.js";

const DEFAULT_THRESHOLD = 0.5;
const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "fixtures",
  "classifier-eval",
  "labels.jsonl",
);

interface EvalArgs {
  readonly dbPath: string | null;
  readonly split: "all" | "train" | "test";
  readonly topMisclass: number;
}

interface RowOutcome {
  readonly row: LabelRow;
  readonly verdict: Classification;
  readonly predicted: EntryType | null;
  readonly correct: boolean;
}

function parseArgs(argv: readonly string[]): EvalArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args.set(key, value);
        i += 1;
      }
    }
  }
  const splitArg = args.get("split") ?? "all";
  if (splitArg !== "all" && splitArg !== "train" && splitArg !== "test") {
    throw new Error(`--split must be all|train|test, got ${splitArg}`);
  }
  return {
    dbPath: args.get("db") ?? null,
    split: splitArg,
    topMisclass: Number(args.get("top") ?? "10"),
  };
}

function loadFixture(split: EvalArgs["split"]): LabelRow[] {
  const contents = readFileSync(FIXTURE_PATH, "utf8");
  const rows: LabelRow[] = [];
  for (const [idx, line] of contents.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    const parsed = LabelRowSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`labels.jsonl line ${idx + 1}: ${parsed.error.message}`);
    }
    if (split === "all" || parsed.data.split === split) {
      rows.push(parsed.data);
    }
  }
  return rows;
}

function openEvalDb(dbPath: string | null): Database {
  if (dbPath === null) return initDatabase(":memory:");
  return new Database(dbPath, { readwrite: true, create: false });
}

function predictedTypeFromVerdict(verdict: Classification): EntryType | null {
  if (
    verdict.signalStrength >= DEFAULT_THRESHOLD &&
    verdict.candidateType !== null
  ) {
    return verdict.candidateType;
  }
  return null;
}

function evaluateRows(db: Database, rows: readonly LabelRow[]): RowOutcome[] {
  return rows.map((row) => {
    const stage1 = classifyEvent({ type: row.event_type, payload: row.payload });
    const verdict = rerankWithGraphify(db, stage1, row.payload);
    const predicted = predictedTypeFromVerdict(verdict);
    const correct = predicted === row.expected.candidateType;
    return { row, verdict, predicted, correct };
  });
}

interface TypeMetrics {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

function computeTypeMetrics(
  outcomes: readonly RowOutcome[],
  type: EntryType,
): TypeMetrics {
  let tp = 0, fp = 0, fn = 0;
  for (const o of outcomes) {
    const expected = o.row.expected.candidateType === type;
    const predicted = o.predicted === type;
    if (predicted && expected) tp += 1;
    else if (predicted && !expected) fp += 1;
    else if (!predicted && expected) fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function computeBloatScore(outcomes: readonly RowOutcome[]): number {
  const created = outcomes.filter((o) => o.predicted !== null).length;
  const expectedPositives = outcomes.filter(
    (o) => o.row.expected.candidateType !== null,
  ).length;
  return (created - expectedPositives) / Math.max(1, outcomes.length);
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderReport(outcomes: readonly RowOutcome[], topMisclass: number): string {
  const lines: string[] = [];
  lines.push(`Rows evaluated: ${outcomes.length}`);
  const correct = outcomes.filter((o) => o.correct).length;
  lines.push(`Overall accuracy: ${formatPercent(correct / outcomes.length)}`);
  lines.push(`Bloat score: ${computeBloatScore(outcomes).toFixed(3)} (target < 0.05)`);
  lines.push("");
  lines.push("Per-type metrics:");
  lines.push(
    ["type", "TP", "FP", "FN", "precision", "recall", "F1"].join("\t"),
  );
  for (const t of CANDIDATE_TYPES) {
    const m = computeTypeMetrics(outcomes, t);
    lines.push(
      [
        t,
        m.tp,
        m.fp,
        m.fn,
        formatPercent(m.precision),
        formatPercent(m.recall),
        m.f1.toFixed(3),
      ].join("\t"),
    );
  }

  const misclass = outcomes.filter((o) => !o.correct).slice(0, topMisclass);
  if (misclass.length > 0) {
    lines.push("");
    lines.push(`Top ${misclass.length} mis-classifications:`);
    for (const o of misclass) {
      const text = payloadExcerpt(o.row.payload);
      lines.push(
        `  ${o.row.id} (${o.row.event_type}) expected=${o.row.expected.candidateType} predicted=${o.predicted} strength=${o.verdict.signalStrength.toFixed(2)} rules=[${o.verdict.ruleIds.join(",")}]`,
      );
      lines.push(`    payload: ${text}`);
    }
  }
  return lines.join("\n");
}

function payloadExcerpt(payload: Record<string, unknown>): string {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.length > 0) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return JSON.stringify(payload).slice(0, 80);
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2));
  const rows = loadFixture(args.split);
  if (rows.length === 0) {
    console.error(`No rows in fixture for split=${args.split}`);
    process.exit(2);
  }
  const db = openEvalDb(args.dbPath);
  const outcomes = evaluateRows(db, rows);
  console.log(renderReport(outcomes, args.topMisclass));
  db.close();
  const bloat = computeBloatScore(outcomes);
  process.exit(bloat > 0.05 ? 1 : 0);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  main();
}

export {
  computeBloatScore,
  computeTypeMetrics,
  evaluateRows,
  loadFixture,
  openEvalDb,
  predictedTypeFromVerdict,
};
