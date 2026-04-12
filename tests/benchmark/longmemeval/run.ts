#!/usr/bin/env bun
/**
 * LongMemEval benchmark runner for Gyst.
 *
 * Runs the Gyst retrieval pipeline against the LongMemEval_s dataset
 * and reports per-category and overall retrieval metrics.
 *
 * Usage:
 *   bun run tests/benchmark/longmemeval/run.ts              full (5 strategies)
 *   bun run tests/benchmark/longmemeval/run.ts --fast       BM25+graph+temporal only
 *   bun run tests/benchmark/longmemeval/run.ts --limit 10   10-question subset for smoke
 *
 * Scoring: Option B from the task spec — retrieval-only accuracy.
 * A question counts as "hit" when any of the top-5 retrieved session
 * IDs appears in answer_session_ids. MRR@5 is the mean reciprocal rank
 * of the first hit across all questions.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, canLoadExtensions } from "../../../src/store/database.js";
import { initVectorStore, backfillVectors } from "../../../src/store/embeddings.js";
import {
  ingestHaystack,
  retrieveTopK,
  scoreRetrieval,
  type LmeQuestion,
  type QuestionResult,
} from "./adapter.js";

// ---------------------------------------------------------------------------
// Paths + CLI flags
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = resolve(__dirname, "data/longmemeval_s.json");
const RESULTS_PATH = resolve(__dirname, "results.json");
const ROOT_RESULTS_PATH = resolve(__dirname, "../../../benchmark-longmemeval.json");

interface CliArgs {
  readonly fast: boolean;
  readonly limit: number | null;
  readonly topK: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let fast = false;
  let limit: number | null = null;
  let topK = 5;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--fast") fast = true;
    else if (arg === "--limit") {
      const next = argv[i + 1];
      if (next !== undefined) {
        limit = parseInt(next, 10);
        i += 1;
      }
    } else if (arg === "--top") {
      const next = argv[i + 1];
      if (next !== undefined) {
        topK = parseInt(next, 10);
        i += 1;
      }
    }
  }
  return { fast, limit, topK };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface CategoryStats {
  total: number;
  hits: number;
  mrrSum: number;
  recallSum: number;
}

interface Report {
  readonly totalQuestions: number;
  readonly fast: boolean;
  readonly topK: number;
  readonly overall: {
    readonly hitRate: number;
    readonly mrrAtK: number;
    readonly recallAtK: number;
  };
  readonly byCategory: Record<
    string,
    { total: number; hitRate: number; mrrAtK: number; recallAtK: number }
  >;
  readonly totalMs: number;
  avgIngestMs: number;
  readonly avgRetrievalMs: number;
  readonly timestamp: string;
}

function aggregate(results: readonly QuestionResult[], cliArgs: CliArgs, totalMs: number): Report {
  const byCategory = new Map<string, CategoryStats>();
  let overallHits = 0;
  let overallMrrSum = 0;
  let overallRecallSum = 0;
  let retrievalMsSum = 0;

  for (const r of results) {
    overallHits += r.hit ? 1 : 0;
    overallMrrSum += r.reciprocalRank;
    overallRecallSum += r.recallAtK;
    retrievalMsSum += r.retrievalMs;

    const cat = byCategory.get(r.questionType) ?? {
      total: 0,
      hits: 0,
      mrrSum: 0,
      recallSum: 0,
    };
    cat.total += 1;
    cat.hits += r.hit ? 1 : 0;
    cat.mrrSum += r.reciprocalRank;
    cat.recallSum += r.recallAtK;
    byCategory.set(r.questionType, cat);
  }

  const n = results.length;
  const catOut: Record<string, { total: number; hitRate: number; mrrAtK: number; recallAtK: number }> = {};
  for (const [cat, stats] of byCategory.entries()) {
    catOut[cat] = {
      total: stats.total,
      hitRate: stats.hits / stats.total,
      mrrAtK: stats.mrrSum / stats.total,
      recallAtK: stats.recallSum / stats.total,
    };
  }

  return {
    totalQuestions: n,
    fast: cliArgs.fast,
    topK: cliArgs.topK,
    overall: {
      hitRate: n > 0 ? overallHits / n : 0,
      mrrAtK: n > 0 ? overallMrrSum / n : 0,
      recallAtK: n > 0 ? overallRecallSum / n : 0,
    },
    byCategory: catOut,
    totalMs,
    avgIngestMs: 0,
    avgRetrievalMs: n > 0 ? retrievalMsSum / n : 0,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function num(n: number): string {
  return n.toFixed(3);
}

function renderReport(report: Report): string {
  const lines: string[] = [];
  const mode = report.fast ? "FAST (no embeddings)" : "FULL (5 strategies)";
  lines.push("");
  lines.push("===============================================================");
  lines.push("  GYST — LongMemEval Benchmark Results");
  lines.push("===============================================================");
  lines.push("");
  lines.push(`  Mode: ${mode}`);
  lines.push(`  Questions: ${report.totalQuestions}`);
  lines.push(`  Top-K: ${report.topK}`);
  lines.push("");
  lines.push(`  Overall Accuracy (Hit Rate @${report.topK}): ${pct(report.overall.hitRate)}`);
  lines.push("");
  lines.push("  Compared to published results:");
  lines.push("  ---------------------------------");
  lines.push("  Emergence AI (Mar 2025):   86.0%");
  lines.push("  EverMemOS:                 83.0%");
  lines.push("  Hindsight (disputed):      91.4%");
  lines.push("  TiMem:                     76.9%");
  lines.push("  Zep / Graphiti:            71.2%");
  lines.push("  Full-context GPT-4o:       60.2%");
  lines.push(`  >>> Gyst (${mode.split(" ")[0]}):                ${pct(report.overall.hitRate)} <<<`);
  lines.push("");
  lines.push("  Per-Category Breakdown:");
  lines.push("  ------------------------");
  const categoryOrder = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
  ];
  for (const cat of categoryOrder) {
    const stats = report.byCategory[cat];
    if (stats === undefined) continue;
    const label = cat.padEnd(26);
    lines.push(
      `  ${label} ${pct(stats.hitRate).padStart(6)}  MRR@${report.topK}=${num(stats.mrrAtK)}  (${stats.total} questions)`,
    );
  }
  lines.push("");
  lines.push("  Retrieval Metrics:");
  lines.push("  ------------------");
  lines.push(`  MRR@${report.topK}:     ${num(report.overall.mrrAtK)}`);
  lines.push(`  Recall@${report.topK}:  ${num(report.overall.recallAtK)}`);
  lines.push(`  Hit Rate:  ${num(report.overall.hitRate)}`);
  lines.push("");
  lines.push("  Performance:");
  lines.push("  ------------");
  lines.push(`  Total time:    ${(report.totalMs / 1000).toFixed(1)}s`);
  lines.push(`  Avg ingest:    ${report.avgIngestMs.toFixed(0)}ms per question`);
  lines.push(`  Avg retrieval: ${report.avgRetrievalMs.toFixed(0)}ms per question`);
  lines.push("");

  const weakest = Object.entries(report.byCategory)
    .sort((a, b) => a[1].hitRate - b[1].hitRate)
    .slice(0, 3);
  if (weakest.length > 0) {
    lines.push("  Weakest categories (focus for improvement):");
    lines.push("  -------------------------------------------");
    for (let i = 0; i < weakest.length; i++) {
      const [cat, stats] = weakest[i]!;
      lines.push(`  ${i + 1}. ${cat} at ${pct(stats.hitRate)}`);
    }
    lines.push("");
  }

  lines.push("===============================================================");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

  process.stdout.write("Loading LongMemEval_s dataset...\n");
  const loadStart = performance.now();
  const raw = readFileSync(DATA_PATH, "utf8");
  const dataset = JSON.parse(raw) as LmeQuestion[];
  const loadMs = performance.now() - loadStart;
  process.stdout.write(`  Loaded ${dataset.length} questions in ${loadMs.toFixed(0)}ms\n`);

  const questions = cliArgs.limit !== null ? dataset.slice(0, cliArgs.limit) : dataset;
  process.stdout.write(`  Running on ${questions.length} questions`);
  if (cliArgs.fast) process.stdout.write(" [FAST mode, no embeddings]");
  process.stdout.write("\n\n");

  // Prime the custom-SQLite flag by opening a throwaway database.
  // canLoadExtensions() reads a module-level flag that's only set inside
  // initDatabase() (via applyCustomSqliteOnce). Without this priming call
  // the first check runs before any DB exists and always returns false,
  // which would silently disable semantic search for the whole run.
  initDatabase(":memory:").close();
  const semanticAvailable = !cliArgs.fast && canLoadExtensions();
  if (!cliArgs.fast && !semanticAvailable) {
    process.stdout.write("WARNING: semantic search unavailable — falling back to FAST mode\n\n");
  }

  const results: QuestionResult[] = [];
  const runStart = performance.now();
  let totalIngestMs = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const tmpDbPath = `/tmp/gyst-lme-${process.pid}-${i}.db`;
    const db = initDatabase(tmpDbPath);

    if (semanticAvailable) {
      initVectorStore(db);
    }

    const ingestStart = performance.now();
    const ingested = ingestHaystack(db, q);
    const ingestMs = performance.now() - ingestStart;
    totalIngestMs += ingestMs;

    if (semanticAvailable) {
      try {
        await backfillVectors(db);
      } catch {
        // continue without vectors for this question
      }
    }

    const retrievalStart = performance.now();
    const retrieved = await retrieveTopK(db, q, {
      fast: cliArgs.fast || !semanticAvailable,
      topK: cliArgs.topK,
    });
    const retrievalMs = performance.now() - retrievalStart;

    const score = scoreRetrieval(retrieved, q.answer_session_ids);

    results.push({
      questionId: q.question_id,
      questionType: q.question_type,
      question: q.question,
      groundTruth: q.answer_session_ids,
      retrieved,
      hit: score.hit,
      reciprocalRank: score.reciprocalRank,
      recallAtK: score.recallAtK,
      ingestedCount: ingested,
      retrievalMs,
    });

    db.close();
    try {
      if (existsSync(tmpDbPath)) unlinkSync(tmpDbPath);
      if (existsSync(tmpDbPath + "-wal")) unlinkSync(tmpDbPath + "-wal");
      if (existsSync(tmpDbPath + "-shm")) unlinkSync(tmpDbPath + "-shm");
    } catch {
      // best-effort cleanup
    }

    if ((i + 1) % 25 === 0 || i === questions.length - 1) {
      const elapsedS = ((performance.now() - runStart) / 1000).toFixed(1);
      const hits = results.filter((r) => r.hit).length;
      process.stdout.write(
        `  [${i + 1}/${questions.length}] ${elapsedS}s elapsed, hit rate so far: ${pct(hits / results.length)}\n`,
      );
    }
  }

  const totalMs = performance.now() - runStart;
  const report = aggregate(results, cliArgs, totalMs);
  report.avgIngestMs = totalIngestMs / results.length;

  const text = renderReport(report);
  process.stdout.write(text);

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify({ report, results }, null, 2));
  writeFileSync(ROOT_RESULTS_PATH, JSON.stringify({ report, results }, null, 2));
  process.stdout.write(`Results saved to ${RESULTS_PATH}\n`);
  process.stdout.write(`Summary saved to  ${ROOT_RESULTS_PATH}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`LongMemEval runner failed: ${msg}\n`);
  if (err instanceof Error && err.stack !== undefined) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
