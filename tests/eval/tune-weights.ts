#!/usr/bin/env bun
/**
 * Weight Tuning Script for Gyst Search
 *
 * Performs a grid search over Reciprocal Rank Fusion k values and evaluates
 * each configuration against the labelled query set.
 *
 * Run:
 *   bun run tests/eval/tune-weights.ts
 *
 * Reports the best (k) configuration by MRR@5, Precision@5, Recall@5, NDCG@5.
 * Saves full grid-search results to tests/eval/tune-results.json.
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
  reciprocalRankFusion,
} from "../../src/store/search.js";
import type { RankedResult } from "../../src/store/search.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = resolve(__dirname, "../fixtures");
const TUNE_RESULTS_PATH = resolve(__dirname, "tune-results.json");
const TOP_K = 5;

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

interface FixtureEntry extends EntryRow {
  readonly errorSignature?: string;
}

interface EvalQuery {
  readonly id: string;
  readonly query: string;
  readonly description: string;
  readonly expected_ids: readonly string[];
  readonly type_filter: string | null;
  readonly file_context: readonly string[];
}

// ---------------------------------------------------------------------------
// Tuning configuration
// ---------------------------------------------------------------------------

/**
 * Grid search space.
 *
 * k (RRF smoothing constant): controls how steeply rank position is rewarded.
 *   - Smaller k (e.g. 10–20) strongly rewards rank-1 results.
 *   - Larger k (e.g. 60–120) distributes weight more evenly across ranks.
 *   - Default is 60 (Cormack et al. 2009 original paper recommendation).
 *
 * filePathWeight: multiplier applied to the file-path results list score
 *   before fusion. Values > 1 boost file-path matches; values < 1 discount them.
 *   Simulated by duplicating the list `weight` times in the fusion input.
 *
 * graphWeight: same multiplier concept for graph results.
 */
const RRF_K_VALUES = [10, 20, 30, 40, 60, 80, 100, 120] as const;
const FILE_PATH_WEIGHTS = [0.5, 1, 2, 3] as const;
const GRAPH_WEIGHTS = [0.5, 1, 2] as const;

// ---------------------------------------------------------------------------
// Metrics (identical to retrieval-eval.ts — kept local to avoid coupling)
// ---------------------------------------------------------------------------

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

function computePrecision(
  actualIds: string[],
  expectedIds: readonly string[],
  k: number,
): number {
  if (actualIds.length === 0) return 0;
  const topK = actualIds.slice(0, k);
  const expectedSet = new Set(expectedIds);
  return topK.filter((id) => expectedSet.has(id)).length / k;
}

function computeRecall(
  actualIds: string[],
  expectedIds: readonly string[],
  k: number,
): number {
  if (expectedIds.length === 0) return 1;
  const topK = actualIds.slice(0, k);
  const expectedSet = new Set(expectedIds);
  return topK.filter((id) => expectedSet.has(id)).length / expectedIds.length;
}

function computeNdcg(
  actualIds: string[],
  expectedIds: readonly string[],
  k: number,
): number {
  const expectedSet = new Set(expectedIds);
  const topK = actualIds.slice(0, k);
  const dcg = topK.reduce(
    (sum, id, index) =>
      sum + (expectedSet.has(id) ? 1 : 0) / Math.log2(index + 2),
    0,
  );
  const numRelevant = Math.min(expectedIds.length, k);
  const idcg = Array.from({ length: numRelevant }, (_, i) =>
    1 / Math.log2(i + 2),
  ).reduce((s, v) => s + v, 0);
  if (idcg === 0) return 1;
  return dcg / idcg;
}

// ---------------------------------------------------------------------------
// Weighted RRF fusion
// ---------------------------------------------------------------------------

/**
 * Applies RRF fusion with optional per-list weight amplification.
 * Weight is simulated by repeating the result list `Math.round(weight)` times
 * (for integer weights) or interpolating by scaling the contribution.
 * We use the scaling approach: each list's RRF contribution is multiplied by
 * its weight before accumulation.
 */
function weightedRRF(
  rankedLists: Array<{ list: RankedResult[]; weight: number }>,
  k: number,
): RankedResult[] {
  if (rankedLists.length === 0) return [];

  const fusedScores = new Map<string, number>();

  for (const { list, weight } of rankedLists) {
    list.forEach((result, index) => {
      const rank = index + 1;
      const contribution = weight / (k + rank);
      const current = fusedScores.get(result.id) ?? 0;
      fusedScores.set(result.id, current + contribution);
    });
  }

  return Array.from(fusedScores.entries())
    .map(([id, score]) => ({ id, score, source: "rrf" as const }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Evaluation for a single configuration
// ---------------------------------------------------------------------------

interface ConfigScore {
  readonly rrfK: number;
  readonly filePathWeight: number;
  readonly graphWeight: number;
  readonly mrr: number;
  readonly meanPrecision: number;
  readonly meanRecall: number;
  readonly meanNdcg: number;
  readonly hitRate: number;
}

function evaluateConfig(
  queries: EvalQuery[],
  rawResults: Map<
    string,
    {
      filePathResults: RankedResult[];
      bm25Results: RankedResult[];
      graphResults: RankedResult[];
    }
  >,
  rrfK: number,
  filePathWeight: number,
  graphWeight: number,
): ConfigScore {
  let totalRR = 0;
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalNdcg = 0;
  let hits = 0;

  for (const query of queries) {
    const raw = rawResults.get(query.id);
    if (!raw) continue;

    const listsToFuse: Array<{ list: RankedResult[]; weight: number }> = [];

    if (raw.filePathResults.length > 0) {
      listsToFuse.push({ list: raw.filePathResults, weight: filePathWeight });
    }
    if (raw.bm25Results.length > 0) {
      listsToFuse.push({ list: raw.bm25Results, weight: 1.0 });
    }
    if (raw.graphResults.length > 0) {
      listsToFuse.push({ list: raw.graphResults, weight: graphWeight });
    }

    const fused = weightedRRF(listsToFuse, rrfK);
    const actualIds = fused.slice(0, TOP_K).map((r) => r.id);

    const rr = computeReciprocalRank(actualIds, query.expected_ids);
    const precision = computePrecision(actualIds, query.expected_ids, TOP_K);
    const recall = computeRecall(actualIds, query.expected_ids, TOP_K);
    const ndcg = computeNdcg(actualIds, query.expected_ids, TOP_K);

    totalRR += rr;
    totalPrecision += precision;
    totalRecall += recall;
    totalNdcg += ndcg;
    if (recall > 0) hits++;
  }

  const n = queries.length;
  return {
    rrfK,
    filePathWeight,
    graphWeight,
    mrr: totalRR / n,
    meanPrecision: totalPrecision / n,
    meanRecall: totalRecall / n,
    meanNdcg: totalNdcg / n,
    hitRate: hits / n,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padRight(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function renderTopConfigs(configs: ConfigScore[], n = 20): void {
  const sorted = [...configs].sort((a, b) => b.mrr - a.mrr);
  const top = sorted.slice(0, n);

  const COL_K = 6;
  const COL_FW = 8;
  const COL_GW = 8;
  const COL_MRR = 8;
  const COL_P = 8;
  const COL_R = 8;
  const COL_NDCG = 8;
  const COL_HIT = 8;

  const sep =
    "+" +
    [COL_K, COL_FW, COL_GW, COL_MRR, COL_P, COL_R, COL_NDCG, COL_HIT]
      .map((w) => "-".repeat(w + 2))
      .join("+") +
    "+";

  const header =
    "| " +
    padRight("k", COL_K) +
    " | " +
    padRight("fp_wt", COL_FW) +
    " | " +
    padRight("gr_wt", COL_GW) +
    " | " +
    padRight("MRR@5", COL_MRR) +
    " | " +
    padRight("P@5", COL_P) +
    " | " +
    padRight("R@5", COL_R) +
    " | " +
    padRight("NDCG@5", COL_NDCG) +
    " | " +
    padRight("HitRate", COL_HIT) +
    " |";

  console.log(`\n  TOP ${n} CONFIGURATIONS BY MRR@5`);
  console.log("  " + "=".repeat(sep.length - 2));
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const c of top) {
    const row =
      "| " +
      padLeft(String(c.rrfK), COL_K) +
      " | " +
      padLeft(String(c.filePathWeight), COL_FW) +
      " | " +
      padLeft(String(c.graphWeight), COL_GW) +
      " | " +
      padLeft(fmt(c.mrr), COL_MRR) +
      " | " +
      padLeft(fmt(c.meanPrecision), COL_P) +
      " | " +
      padLeft(fmt(c.meanRecall), COL_R) +
      " | " +
      padLeft(fmt(c.meanNdcg), COL_NDCG) +
      " | " +
      padLeft(fmt(c.hitRate), COL_HIT) +
      " |";
    console.log(row);
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n  Gyst Search Weight Tuning");
  console.log("  =========================\n");

  // ---- Load fixtures ----
  const entries = JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, "real-entries.json"), "utf-8"),
  ) as FixtureEntry[];

  const queries = JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, "eval-queries.json"), "utf-8"),
  ) as EvalQuery[];

  console.log(`  Fixtures: ${entries.length} entries, ${queries.length} queries`);

  // ---- Seed database ----
  const tmpDbPath = `/tmp/gyst-tune-${Date.now()}.db`;
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

  // ---- Pre-compute raw search results for all queries (expensive part) ----
  // We do this once so the grid search only re-runs the cheap fusion step.
  console.log("  Pre-computing search results for all queries...");
  const rawResults = new Map<
    string,
    {
      filePathResults: RankedResult[];
      bm25Results: RankedResult[];
      graphResults: RankedResult[];
    }
  >();

  for (const query of queries) {
    const filePathResults =
      query.file_context.length > 0
        ? searchByFilePath(evalDb, [...query.file_context])
        : [];

    const bm25Results = searchByBM25(
      evalDb,
      query.query,
      query.type_filter ?? undefined,
    );

    const graphResults = searchByGraph(evalDb, query.query);

    rawResults.set(query.id, { filePathResults, bm25Results, graphResults });
  }

  console.log("  Done. Running grid search...\n");

  // ---- Grid search ----
  const allConfigs: ConfigScore[] = [];
  let evaluated = 0;
  const total =
    RRF_K_VALUES.length * FILE_PATH_WEIGHTS.length * GRAPH_WEIGHTS.length;

  for (const rrfK of RRF_K_VALUES) {
    for (const filePathWeight of FILE_PATH_WEIGHTS) {
      for (const graphWeight of GRAPH_WEIGHTS) {
        const score = evaluateConfig(
          queries,
          rawResults,
          rrfK,
          filePathWeight,
          graphWeight,
        );
        allConfigs.push(score);
        evaluated++;

        // Progress dot every 10 evaluations
        if (evaluated % 10 === 0) {
          process.stdout.write(
            `\r  Evaluated ${evaluated}/${total} configurations...`,
          );
        }
      }
    }
  }

  console.log(`\r  Evaluated ${total}/${total} configurations. Done.\n`);

  // ---- Render results ----
  renderTopConfigs(allConfigs, Math.min(20, allConfigs.length));

  const best = [...allConfigs].sort((a, b) => b.mrr - a.mrr)[0];
  if (best) {
    console.log("\n  BEST CONFIGURATION:");
    console.log(`    RRF k          : ${best.rrfK}`);
    console.log(`    File-path weight: ${best.filePathWeight}`);
    console.log(`    Graph weight    : ${best.graphWeight}`);
    console.log(`    MRR@5          : ${fmt(best.mrr)}`);
    console.log(`    Precision@5    : ${fmt(best.meanPrecision)}`);
    console.log(`    Recall@5       : ${fmt(best.meanRecall)}`);
    console.log(`    NDCG@5         : ${fmt(best.meanNdcg)}`);
    console.log(`    Hit Rate       : ${fmt(best.hitRate)}`);
  }

  // ---- Save results ----
  const report = {
    timestamp: new Date().toISOString(),
    totalConfigurations: total,
    gridSpace: {
      rrfKValues: [...RRF_K_VALUES],
      filePathWeights: [...FILE_PATH_WEIGHTS],
      graphWeights: [...GRAPH_WEIGHTS],
    },
    bestConfig: best ?? null,
    allConfigs: allConfigs.sort((a, b) => b.mrr - a.mrr),
  };

  mkdirSync(dirname(TUNE_RESULTS_PATH), { recursive: true });
  writeFileSync(TUNE_RESULTS_PATH, JSON.stringify(report, null, 2));
  console.log(`\n  Results saved to ${TUNE_RESULTS_PATH}\n`);

  // ---- Cleanup ----
  evalDb.close();
  try {
    const { unlinkSync } = await import("node:fs");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${tmpDbPath}${suffix}`);
      } catch {
        // file may not exist
      }
    }
  } catch {
    // best-effort cleanup
  }
}

main().catch((err) => {
  console.error("Tuning script crashed:", err);
  process.exit(1);
});
