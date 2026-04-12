#!/usr/bin/env bun
/**
 * CodeMemBench ablation study.
 *
 * Runs the benchmark five times, each time disabling one of the five
 * hybrid strategies, plus one baseline with everything on. Reports per
 * configuration and the delta vs. baseline to show which strategies
 * contribute the most to NDCG@10.
 *
 * Usage:
 *   bun run tests/benchmark/codememb/ablation.ts
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, insertEntry, canLoadExtensions } from "../../../src/store/database.js";
import type { EntryRow } from "../../../src/store/database.js";
import { initVectorStore, backfillVectors } from "../../../src/store/embeddings.js";
import { runHybridSearch, type HybridStrategy } from "../../../src/store/hybrid.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATASET_PATH = resolve(__dirname, "dataset.json");
const RESULTS_PATH = resolve(__dirname, "ablation.json");
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
  readonly entries: EntryRow[];
  readonly queries: BenchmarkQuery[];
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

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function evaluate(
  db: ReturnType<typeof initDatabase>,
  queries: readonly BenchmarkQuery[],
  disable: readonly HybridStrategy[],
): Promise<{ ndcg: number; hitRate: number }> {
  const ndcgs: number[] = [];
  let hits = 0;
  for (const q of queries) {
    const ranked = await runHybridSearch(db, q.text, {
      fileContext: q.fileContext,
      typeFilter: q.typeFilter,
      disableStrategies: disable,
    });
    const actualIds = ranked.slice(0, TOP_K).map((r) => r.id);
    ndcgs.push(computeNdcg(actualIds, q.relevantEntryIds, TOP_K));
    if (actualIds.some((id) => new Set(q.relevantEntryIds).has(id))) hits++;
  }
  return { ndcg: mean(ndcgs), hitRate: hits / queries.length };
}

async function main(): Promise<void> {
  console.log("CodeMemBench ablation starting…");
  if (!existsSync(DATASET_PATH)) {
    throw new Error(`dataset.json not found at ${DATASET_PATH}`);
  }
  const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as Dataset;
  console.log(
    `Dataset: ${dataset.entries.length} entries, ${dataset.queries.length} queries`,
  );

  const tmpDbPath = resolve(__dirname, ".ablation.db");
  if (existsSync(tmpDbPath)) unlinkSync(tmpDbPath);

  const db = initDatabase(tmpDbPath);
  const semanticAvailable = canLoadExtensions();
  if (semanticAvailable) initVectorStore(db);

  console.log("Ingesting…");
  for (const entry of dataset.entries) insertEntry(db, entry);
  if (semanticAvailable) {
    console.log("Backfilling vectors…");
    await backfillVectors(db);
  }

  const configs: Array<{ name: string; disable: HybridStrategy[] }> = [
    { name: "baseline (all strategies)", disable: [] },
    { name: "no bm25", disable: ["bm25"] },
    { name: "no graph", disable: ["graph"] },
    { name: "no file_path", disable: ["file_path"] },
    { name: "no temporal", disable: ["temporal"] },
    { name: "no semantic", disable: ["semantic"] },
  ];

  const results: Array<{
    name: string;
    disable: HybridStrategy[];
    ndcg: number;
    hitRate: number;
    deltaNdcg: number;
    deltaHitRate: number;
  }> = [];

  let baselineNdcg = 0;
  let baselineHitRate = 0;
  for (const cfg of configs) {
    const start = Date.now();
    const { ndcg, hitRate } = await evaluate(db, dataset.queries, cfg.disable);
    const ms = Date.now() - start;
    if (cfg.name.startsWith("baseline")) {
      baselineNdcg = ndcg;
      baselineHitRate = hitRate;
    }
    results.push({
      name: cfg.name,
      disable: cfg.disable,
      ndcg,
      hitRate,
      deltaNdcg: ndcg - baselineNdcg,
      deltaHitRate: hitRate - baselineHitRate,
    });
    console.log(
      `${cfg.name.padEnd(30)} NDCG=${ndcg.toFixed(4)} ` +
        `HitRate=${(hitRate * 100).toFixed(1)}%  ${ms}ms`,
    );
  }

  db.close();
  if (existsSync(tmpDbPath)) unlinkSync(tmpDbPath);

  const report = {
    benchmark: "CodeMemBench ablation",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    topK: TOP_K,
    semanticAvailable,
    totalQueries: dataset.queries.length,
    configurations: results,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nWritten: ${RESULTS_PATH}`);

  console.log("\n=== Ablation table ===");
  console.log(
    "config".padEnd(30) + "NDCG".padStart(10) + "ΔNDCG".padStart(12) +
      "HitRate".padStart(12) + "ΔHit".padStart(12),
  );
  for (const r of results) {
    console.log(
      r.name.padEnd(30) +
        r.ndcg.toFixed(4).padStart(10) +
        (r.deltaNdcg >= 0 ? "+" : "") + r.deltaNdcg.toFixed(4).padStart(11) +
        ((r.hitRate * 100).toFixed(1) + "%").padStart(12) +
        ((r.deltaHitRate * 100).toFixed(1) + "%").padStart(12),
    );
  }
}

main().catch((err) => {
  console.error("Ablation failed:", err);
  process.exit(1);
});
