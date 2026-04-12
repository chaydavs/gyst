#!/usr/bin/env bun
/**
 * Retrieval Evaluation Harness for Gyst
 *
 * Measures MRR@5, Precision@5, Recall@5, NDCG@5 across the labelled query set.
 *
 * Run:
 *   bun run tests/eval/retrieval-eval.ts
 *
 * Exit codes:
 *   0 — MRR@5 >= 0.5 (search is working)
 *   1 — MRR@5 < 0.5  (search is broken or undertrained)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import {
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  searchByTemporal,
  reciprocalRankFusion,
} from "../../src/store/search.js";

// ---------------------------------------------------------------------------
// Path resolution (works with bun when __dirname is unavailable in ESM)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = resolve(__dirname, "../fixtures");
const RESULTS_PATH = resolve(__dirname, "results.json");
const TOP_K = 5;
const MRR_PASS_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

/** Shape of entries in real-entries.json — matches EntryRow plus optional errorSignature */
interface FixtureEntry extends EntryRow {
  readonly errorSignature?: string;
}

/** Shape of queries in eval-queries.json */
interface EvalQuery {
  readonly id: string;
  readonly query: string;
  readonly description: string;
  readonly expected_ids: readonly string[];
  readonly type_filter: string | null;
  readonly file_context: readonly string[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface EvalResult {
  readonly queryId: string;
  readonly query: string;
  readonly description: string;
  readonly expectedIds: readonly string[];
  readonly actualIds: string[];
  readonly reciprocalRank: number;
  readonly precision: number;
  readonly recall: number;
  readonly ndcg: number;
  readonly hit: boolean;
}

interface EvalReport {
  readonly timestamp: string;
  readonly totalQueries: number;
  readonly mrr: number;
  readonly meanPrecision: number;
  readonly meanRecall: number;
  readonly meanNdcg: number;
  readonly hitRate: number;
  readonly results: readonly EvalResult[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Computes the reciprocal rank for a single query result.
 * Returns 1/rank of the first relevant result in actualIds (1-indexed),
 * or 0 if no relevant result is found within the top-K results.
 */
function computeReciprocalRank(
  actualIds: string[],
  expectedIds: readonly string[],
): number {
  const expectedSet = new Set(expectedIds);
  for (let i = 0; i < actualIds.length; i++) {
    if (expectedSet.has(actualIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Precision@K: fraction of retrieved items that are relevant.
 */
function computePrecision(
  actualIds: string[],
  expectedIds: readonly string[],
  k: number,
): number {
  if (actualIds.length === 0) return 0;
  const topK = actualIds.slice(0, k);
  const expectedSet = new Set(expectedIds);
  const relevant = topK.filter((id) => expectedSet.has(id)).length;
  return relevant / k;
}

/**
 * Recall@K: fraction of relevant items that were retrieved in top-K.
 */
function computeRecall(
  actualIds: string[],
  expectedIds: readonly string[],
  k: number,
): number {
  if (expectedIds.length === 0) return 1; // vacuously true
  const topK = actualIds.slice(0, k);
  const expectedSet = new Set(expectedIds);
  const relevant = topK.filter((id) => expectedSet.has(id)).length;
  return relevant / expectedIds.length;
}

/**
 * NDCG@K: Normalized Discounted Cumulative Gain.
 * Binary relevance: 1 if in expectedIds, 0 otherwise.
 */
function computeNdcg(
  actualIds: string[],
  expectedIds: readonly string[],
  k: number,
): number {
  const expectedSet = new Set(expectedIds);
  const topK = actualIds.slice(0, k);

  // DCG: sum of (relevance / log2(rank+1)) for each position
  const dcg = topK.reduce((sum, id, index) => {
    const relevance = expectedSet.has(id) ? 1 : 0;
    return sum + relevance / Math.log2(index + 2); // +2 because log2(1) = 0
  }, 0);

  // IDCG: ideal DCG — all relevant items at the top
  const numRelevant = Math.min(expectedIds.length, k);
  const idcg = Array.from({ length: numRelevant }, (_, index) =>
    1 / Math.log2(index + 2),
  ).reduce((sum, v) => sum + v, 0);

  if (idcg === 0) return 1; // no relevant items — vacuously perfect
  return dcg / idcg;
}

function computeMRR(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.reciprocalRank, 0);
  return sum / results.length;
}

function computeMeanPrecision(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.precision, 0);
  return sum / results.length;
}

function computeMeanRecall(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.recall, 0);
  return sum / results.length;
}

function computeMeanNdcg(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.ndcg, 0);
  return sum / results.length;
}

// ---------------------------------------------------------------------------
// Search fusion helper
// ---------------------------------------------------------------------------

function runFusedSearch(
  db: Database,
  query: EvalQuery,
): string[] {
  const rankedLists = [];

  // Strategy 1: file-path lookup (only if file context is provided)
  if (query.file_context.length > 0) {
    const fileResults = searchByFilePath(db, [...query.file_context]);
    if (fileResults.length > 0) {
      rankedLists.push(fileResults);
    }
  }

  // Strategy 2: BM25 full-text search (with optional type filter)
  const bm25Results = searchByBM25(
    db,
    query.query,
    query.type_filter ?? undefined,
  );
  if (bm25Results.length > 0) {
    rankedLists.push(bm25Results);
  }

  // Strategy 3: Graph traversal
  const graphResults = searchByGraph(db, query.query);
  if (graphResults.length > 0) {
    rankedLists.push(graphResults);
  }

  // Strategy 4: Temporal search (no-op when query has no time signal)
  const temporalResults = searchByTemporal(db, query.query);
  if (temporalResults.length > 0) {
    rankedLists.push(temporalResults);
  }

  // Fuse and return top-K IDs
  const fused = reciprocalRankFusion(rankedLists);
  return fused.slice(0, TOP_K).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// ASCII table rendering
// ---------------------------------------------------------------------------

function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : " ".repeat(width - str.length) + str;
}

function formatScore(n: number): string {
  return n.toFixed(3);
}

function renderResultsTable(results: readonly EvalResult[]): void {
  const COL_ID = 6;
  const COL_QUERY = 42;
  const COL_HIT = 5;
  const COL_MRR = 6;
  const COL_P = 6;
  const COL_R = 6;
  const COL_NDCG = 6;

  const separator =
    "+" +
    "-".repeat(COL_ID + 2) +
    "+" +
    "-".repeat(COL_QUERY + 2) +
    "+" +
    "-".repeat(COL_HIT + 2) +
    "+" +
    "-".repeat(COL_MRR + 2) +
    "+" +
    "-".repeat(COL_P + 2) +
    "+" +
    "-".repeat(COL_R + 2) +
    "+" +
    "-".repeat(COL_NDCG + 2) +
    "+";

  const header =
    "| " +
    padRight("ID", COL_ID) +
    " | " +
    padRight("Query", COL_QUERY) +
    " | " +
    padRight("Hit?", COL_HIT) +
    " | " +
    padRight("RR@5", COL_MRR) +
    " | " +
    padRight("P@5", COL_P) +
    " | " +
    padRight("R@5", COL_R) +
    " | " +
    padRight("NDCG@5", COL_NDCG) +
    " |";

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const r of results) {
    const hitMark = r.hit ? " YES " : "  NO ";
    const queryTrunc =
      r.query.length > COL_QUERY ? r.query.slice(0, COL_QUERY - 1) + "…" : r.query;
    const row =
      "| " +
      padRight(r.queryId, COL_ID) +
      " | " +
      padRight(queryTrunc, COL_QUERY) +
      " | " +
      padRight(hitMark, COL_HIT) +
      " | " +
      padLeft(formatScore(r.reciprocalRank), COL_MRR) +
      " | " +
      padLeft(formatScore(r.precision), COL_P) +
      " | " +
      padLeft(formatScore(r.recall), COL_R) +
      " | " +
      padLeft(formatScore(r.ndcg), COL_NDCG) +
      " |";
    console.log(row);
  }

  console.log(separator);
}

function renderSummary(report: EvalReport): void {
  console.log("\n  OVERALL SCORES");
  console.log("  ==============");
  console.log(`  MRR@5        : ${formatScore(report.mrr)}   (threshold: ${MRR_PASS_THRESHOLD})`);
  console.log(`  Precision@5  : ${formatScore(report.meanPrecision)}`);
  console.log(`  Recall@5     : ${formatScore(report.meanRecall)}`);
  console.log(`  NDCG@5       : ${formatScore(report.meanNdcg)}`);
  console.log(`  Hit Rate     : ${formatScore(report.hitRate)}   (fraction with >= 1 relevant in top-5)`);
  console.log(`  Queries      : ${report.totalQueries}`);
  console.log("");
}

function renderMisses(results: readonly EvalResult[]): void {
  const misses = results.filter((r) => !r.hit);
  if (misses.length === 0) {
    console.log("  No complete misses — all queries returned at least one relevant result!\n");
    return;
  }

  console.log(`  COMPLETE MISSES (${misses.length} queries with Recall@5 = 0):`);
  console.log("  -------------------------------------------------------");
  for (const r of misses) {
    console.log(`  ${r.queryId}: "${r.query}"`);
    console.log(`    Expected : ${r.expectedIds.join(", ")}`);
    console.log(`    Got      : ${r.actualIds.length > 0 ? r.actualIds.join(", ") : "(no results)"}`);
  }
  console.log("");
}

function renderWorstQueries(results: readonly EvalResult[], n = 10): void {
  const sorted = [...results].sort((a, b) => a.reciprocalRank - b.reciprocalRank);
  const worst = sorted.slice(0, n);

  console.log(`  WORST ${n} QUERIES BY RECIPROCAL RANK (debug these first):`);
  console.log("  -----------------------------------------------------------");
  for (const r of worst) {
    console.log(
      `  ${r.queryId} RR=${formatScore(r.reciprocalRank)} | "${r.query.slice(0, 60)}${r.query.length > 60 ? "…" : ""}"`,
    );
    console.log(`    Expected : [${r.expectedIds.join(", ")}]`);
    console.log(`    Got      : [${r.actualIds.join(", ")}]`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n  Gyst Retrieval Evaluation Harness");
  console.log("  ==================================\n");

  // ---- Load fixtures via readFileSync to avoid dynamic import path issues ----
  const entries = JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, "real-entries.json"), "utf-8"),
  ) as FixtureEntry[];

  const queries = JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, "eval-queries.json"), "utf-8"),
  ) as EvalQuery[];

  console.log(`  Loaded ${entries.length} fixture entries and ${queries.length} eval queries.`);

  // ---- Seed database (temp file — initDatabase opens its own handle) ----
  console.log("  Seeding evaluation database...");
  const tmpDbPath = `/tmp/gyst-eval-${Date.now()}.db`;
  const evalDb = initDatabase(tmpDbPath);

  for (const entry of entries) {
    insertEntry(evalDb, {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      content: entry.content,
      files: entry.files,
      tags: entry.tags,
      errorSignature: entry.errorSignature,
      confidence: entry.confidence,
      sourceCount: entry.sourceCount,
      sourceTool: entry.sourceTool,
      status: entry.status ?? "active",
    });
  }

  console.log(`  Seeded ${entries.length} entries.\n`);

  // ---- Evaluate each query ----
  const results: EvalResult[] = [];

  for (const query of queries) {
    const actualIds = runFusedSearch(evalDb, query);

    const rr = computeReciprocalRank(actualIds, query.expected_ids);
    const precision = computePrecision(actualIds, query.expected_ids, TOP_K);
    const recall = computeRecall(actualIds, query.expected_ids, TOP_K);
    const ndcg = computeNdcg(actualIds, query.expected_ids, TOP_K);
    const hit = recall > 0;

    results.push({
      queryId: query.id,
      query: query.query,
      description: query.description,
      expectedIds: query.expected_ids,
      actualIds,
      reciprocalRank: rr,
      precision,
      recall,
      ndcg,
      hit,
    });
  }

  // ---- Compute aggregate metrics ----
  const mrr = computeMRR(results);
  const meanPrecision = computeMeanPrecision(results);
  const meanRecall = computeMeanRecall(results);
  const meanNdcg = computeMeanNdcg(results);
  const hitRate = results.filter((r) => r.hit).length / results.length;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    totalQueries: results.length,
    mrr,
    meanPrecision,
    meanRecall,
    meanNdcg,
    hitRate,
    results,
  };

  // ---- Print report ----
  renderResultsTable(results);
  renderSummary(report);
  renderMisses(results);
  renderWorstQueries(results, Math.min(10, results.length));

  // ---- Save results to JSON ----
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
  console.log(`  Results saved to ${RESULTS_PATH}\n`);

  // ---- Cleanup temp DB ----
  evalDb.close();
  try {
    const { unlinkSync } = await import("node:fs");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${tmpDbPath}${suffix}`);
      } catch {
        // file may not exist — ignore
      }
    }
  } catch {
    // best-effort cleanup — ignore errors
  }

  // ---- Exit code based on MRR threshold ----
  if (mrr < MRR_PASS_THRESHOLD) {
    console.error(
      `  FAIL: MRR@5 = ${formatScore(mrr)} is below the threshold of ${MRR_PASS_THRESHOLD}.`,
    );
    console.error("  The product search is not working well enough. Debug the worst queries above.\n");
    process.exit(1);
  } else {
    console.log(
      `  PASS: MRR@5 = ${formatScore(mrr)} meets the threshold of ${MRR_PASS_THRESHOLD}.\n`,
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Evaluation harness crashed:", err);
  process.exit(1);
});
