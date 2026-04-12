#!/usr/bin/env bun
/**
 * CodeMemBench runner.
 *
 * Loads the dataset, ingests entries into an in-memory Gyst database,
 * backfills vectors, runs every query through runHybridSearch, and
 * reports NDCG@10 / Recall@10 / MRR@10 per category and overall.
 *
 * Usage:
 *   bun run tests/benchmark/codememb/run.ts
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, insertEntry, canLoadExtensions } from "../../../src/store/database.js";
import type { EntryRow } from "../../../src/store/database.js";
import { initVectorStore, backfillVectors } from "../../../src/store/embeddings.js";
import { runHybridSearch } from "../../../src/store/hybrid.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATASET_PATH = resolve(__dirname, "dataset.json");
const RESULTS_PATH = resolve(__dirname, "results.json");
const ROOT_RESULTS_PATH = resolve(__dirname, "../../../benchmark-codememb.json");
const TOP_K = 10;

interface BenchmarkQuery {
  readonly id: string;
  readonly text: string;
  readonly category: string;
  readonly difficulty: "easy" | "medium" | "hard";
  readonly relevantEntryIds: readonly string[];
  readonly fileContext?: readonly string[];
  readonly typeFilter?: string;
}

interface Dataset {
  readonly version: string;
  readonly entryCount: number;
  readonly queryCount: number;
  readonly entries: EntryRow[];
  readonly queries: BenchmarkQuery[];
}

interface QueryResult {
  readonly queryId: string;
  readonly category: string;
  readonly difficulty: string;
  readonly expectedIds: readonly string[];
  readonly actualIds: string[];
  readonly hit: boolean;
  readonly reciprocalRank: number;
  readonly recall: number;
  readonly ndcg: number;
}

function loadDataset(): Dataset {
  if (!existsSync(DATASET_PATH)) {
    throw new Error(
      `dataset.json not found at ${DATASET_PATH}. Run generate-dataset.ts first.`,
    );
  }
  return JSON.parse(readFileSync(DATASET_PATH, "utf8")) as Dataset;
}

function computeNdcg(
  actualIds: readonly string[],
  expectedIds: readonly string[],
  k: number,
): number {
  const expectedSet = new Set(expectedIds);
  const topK = actualIds.slice(0, k);
  const dcg = topK.reduce((sum, id, index) => {
    const relevance = expectedSet.has(id) ? 1 : 0;
    return sum + relevance / Math.log2(index + 2);
  }, 0);
  const numRelevant = Math.min(expectedIds.length, k);
  const idcg = Array.from(
    { length: numRelevant },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((sum, v) => sum + v, 0);
  if (idcg === 0) return 1;
  return dcg / idcg;
}

function computeRecall(
  actualIds: readonly string[],
  expectedIds: readonly string[],
  k: number,
): number {
  if (expectedIds.length === 0) return 1;
  const expectedSet = new Set(expectedIds);
  const topK = actualIds.slice(0, k);
  const hits = topK.filter((id) => expectedSet.has(id)).length;
  return hits / expectedIds.length;
}

function computeReciprocalRank(
  actualIds: readonly string[],
  expectedIds: readonly string[],
): number {
  const expectedSet = new Set(expectedIds);
  for (let i = 0; i < actualIds.length; i++) {
    if (expectedSet.has(actualIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function runBenchmark(): Promise<void> {
  console.log("CodeMemBench runner starting…");
  const dataset = loadDataset();
  console.log(
    `Loaded dataset: ${dataset.entryCount} entries, ${dataset.queryCount} queries`,
  );

  const tmpDbPath = resolve(__dirname, ".codememb.db");
  if (existsSync(tmpDbPath)) unlinkSync(tmpDbPath);

  const db = initDatabase(tmpDbPath);
  const semanticAvailable = canLoadExtensions();
  if (semanticAvailable) {
    initVectorStore(db);
  }

  console.log("Ingesting entries…");
  const ingestStart = Date.now();
  for (const entry of dataset.entries) {
    insertEntry(db, entry);
  }
  const ingestMs = Date.now() - ingestStart;
  console.log(`Ingest: ${ingestMs}ms (${(ingestMs / dataset.entries.length).toFixed(2)}ms/entry)`);

  if (semanticAvailable) {
    console.log("Backfilling vectors…");
    const vecStart = Date.now();
    const count = await backfillVectors(db);
    console.log(`Backfilled ${count} vectors in ${Date.now() - vecStart}ms`);
  } else {
    console.log("sqlite-vec not available — semantic strategy disabled");
  }

  console.log("Running queries…");
  const results: QueryResult[] = [];
  const retrieveStart = Date.now();
  for (const query of dataset.queries) {
    const ranked = await runHybridSearch(db, query.text, {
      fileContext: query.fileContext,
      typeFilter: query.typeFilter,
    });
    const actualIds = ranked.slice(0, TOP_K).map((r) => r.id);
    const ndcg = computeNdcg(actualIds, query.relevantEntryIds, TOP_K);
    const recall = computeRecall(actualIds, query.relevantEntryIds, TOP_K);
    const rr = computeReciprocalRank(actualIds, query.relevantEntryIds);
    const expectedSet = new Set(query.relevantEntryIds);
    const hit = actualIds.some((id) => expectedSet.has(id));
    results.push({
      queryId: query.id,
      category: query.category,
      difficulty: query.difficulty,
      expectedIds: query.relevantEntryIds,
      actualIds,
      hit,
      reciprocalRank: rr,
      recall,
      ndcg,
    });
  }
  const retrieveMs = Date.now() - retrieveStart;
  console.log(
    `Retrieval: ${retrieveMs}ms (${(retrieveMs / dataset.queries.length).toFixed(2)}ms/query)`,
  );

  db.close();
  if (existsSync(tmpDbPath)) unlinkSync(tmpDbPath);

  // Aggregate
  const overall = {
    ndcg: mean(results.map((r) => r.ndcg)),
    recall: mean(results.map((r) => r.recall)),
    mrr: mean(results.map((r) => r.reciprocalRank)),
    hitRate: results.filter((r) => r.hit).length / results.length,
  };

  const byCategory = new Map<string, QueryResult[]>();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  const categoryMetrics: Record<
    string,
    { count: number; ndcg: number; recall: number; mrr: number; hitRate: number }
  > = {};
  for (const [cat, rs] of byCategory.entries()) {
    categoryMetrics[cat] = {
      count: rs.length,
      ndcg: mean(rs.map((r) => r.ndcg)),
      recall: mean(rs.map((r) => r.recall)),
      mrr: mean(rs.map((r) => r.reciprocalRank)),
      hitRate: rs.filter((r) => r.hit).length / rs.length,
    };
  }

  const byDifficulty = new Map<string, QueryResult[]>();
  for (const r of results) {
    if (!byDifficulty.has(r.difficulty)) byDifficulty.set(r.difficulty, []);
    byDifficulty.get(r.difficulty)!.push(r);
  }
  const difficultyMetrics: Record<
    string,
    { count: number; ndcg: number; recall: number; mrr: number; hitRate: number }
  > = {};
  for (const [diff, rs] of byDifficulty.entries()) {
    difficultyMetrics[diff] = {
      count: rs.length,
      ndcg: mean(rs.map((r) => r.ndcg)),
      recall: mean(rs.map((r) => r.recall)),
      mrr: mean(rs.map((r) => r.reciprocalRank)),
      hitRate: rs.filter((r) => r.hit).length / rs.length,
    };
  }

  const report = {
    benchmark: "CodeMemBench",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    datasetPath: "tests/benchmark/codememb/dataset.json",
    totalQueries: results.length,
    topK: TOP_K,
    semanticAvailable,
    ingestMs,
    retrieveMs,
    overall,
    categoryMetrics,
    difficultyMetrics,
  };

  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(ROOT_RESULTS_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("\n=== CodeMemBench Results ===");
  console.log(
    `NDCG@${TOP_K}: ${overall.ndcg.toFixed(4)}  ` +
      `Recall@${TOP_K}: ${overall.recall.toFixed(4)}  ` +
      `MRR@${TOP_K}: ${overall.mrr.toFixed(4)}  ` +
      `Hit Rate: ${(overall.hitRate * 100).toFixed(1)}%`,
  );
  console.log("\nPer category:");
  for (const [cat, m] of Object.entries(categoryMetrics)) {
    console.log(
      `  ${cat.padEnd(22)} n=${String(m.count).padStart(3)}  ` +
        `NDCG=${m.ndcg.toFixed(3)}  Recall=${m.recall.toFixed(3)}  ` +
        `MRR=${m.mrr.toFixed(3)}  Hit=${(m.hitRate * 100).toFixed(1)}%`,
    );
  }
  console.log("\nPer difficulty:");
  for (const [diff, m] of Object.entries(difficultyMetrics)) {
    console.log(
      `  ${diff.padEnd(8)} n=${String(m.count).padStart(3)}  ` +
        `NDCG=${m.ndcg.toFixed(3)}  Recall=${m.recall.toFixed(3)}  ` +
        `MRR=${m.mrr.toFixed(3)}  Hit=${(m.hitRate * 100).toFixed(1)}%`,
    );
  }
  console.log(`\nWritten: ${RESULTS_PATH}`);
  console.log(`Written: ${ROOT_RESULTS_PATH}`);
}

runBenchmark().catch((err) => {
  console.error("CodeMemBench run failed:", err);
  process.exit(1);
});
