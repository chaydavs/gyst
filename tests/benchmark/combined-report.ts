#!/usr/bin/env bun
/**
 * Combined benchmark report.
 *
 * Reads the three benchmark result JSONs and prints a launch-ready
 * summary table to stdout. Tolerant of missing files — if a benchmark
 * hasn't been run yet, it shows "not yet run" instead of crashing.
 *
 * Sources:
 *   benchmark-longmemeval.json / tests/benchmark/longmemeval/results.json
 *   benchmark-codememb.json
 *   benchmark-coir.json
 *
 * Usage:
 *   bun run tests/benchmark/combined-report.ts
 *   bun run tests/benchmark/combined-report.ts --json   # emit JSON only
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

const LONGMEM_PATH_A = resolve(REPO_ROOT, "benchmark-longmemeval.json");
const LONGMEM_PATH_B = resolve(REPO_ROOT, "tests/benchmark/longmemeval/results.json");
const CODEMEMB_PATH = resolve(REPO_ROOT, "benchmark-codememb.json");
const CODEMEMB_ABLATION_PATH = resolve(
  REPO_ROOT,
  "tests/benchmark/codememb/ablation.json",
);
const COIR_PATH = resolve(REPO_ROOT, "benchmark-coir.json");
const OUT_PATH = resolve(REPO_ROOT, "benchmark-combined.json");

interface LongMemReport {
  readonly report: {
    readonly totalQuestions: number;
    readonly topK: number;
    readonly overall: {
      readonly hitRate: number;
      readonly mrrAtK: number;
      readonly recallAtK: number;
    };
    readonly timestamp: string;
  };
}

interface CodeMemBenchReport {
  readonly benchmark: string;
  readonly timestamp: string;
  readonly totalQueries: number;
  readonly topK: number;
  readonly semanticAvailable: boolean;
  readonly overall: {
    readonly ndcg: number;
    readonly recall: number;
    readonly mrr: number;
    readonly hitRate: number;
  };
}

interface CoirReport {
  readonly benchmark: string;
  readonly mode: string;
  readonly model: string;
  readonly subtasks_run: readonly string[];
  readonly subtasks_total: number;
  readonly per_task: Record<
    string,
    { ndcg_at_10: number; recall_at_10: number; map_at_10: number }
  >;
  readonly mean_ndcg_at_10: number;
  readonly mean_recall_at_10: number;
  readonly mean_map_at_10: number;
}

interface CodeMemAblationReport {
  readonly configurations: ReadonlyArray<{
    readonly name: string;
    readonly ndcg: number;
    readonly hitRate: number;
    readonly deltaNdcg: number;
    readonly deltaHitRate: number;
  }>;
}

function tryRead<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readLongMem(): LongMemReport | null {
  return (
    tryRead<LongMemReport>(LONGMEM_PATH_A) ??
    tryRead<LongMemReport>(LONGMEM_PATH_B)
  );
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number): string {
  return v.toFixed(4);
}

function printHeader(title: string): void {
  const bar = "=".repeat(title.length);
  console.log(`\n${title}\n${bar}`);
}

function main(): void {
  const jsonOnly = process.argv.includes("--json");
  const longmem = readLongMem();
  const codememb = tryRead<CodeMemBenchReport>(CODEMEMB_PATH);
  const codemembAblation = tryRead<CodeMemAblationReport>(CODEMEMB_ABLATION_PATH);
  const coir = tryRead<CoirReport>(COIR_PATH);

  const combined = {
    generatedAt: new Date().toISOString(),
    longmemeval: longmem
      ? {
          totalQuestions: longmem.report.totalQuestions,
          topK: longmem.report.topK,
          hitRate: longmem.report.overall.hitRate,
          mrr: longmem.report.overall.mrrAtK,
          recall: longmem.report.overall.recallAtK,
          timestamp: longmem.report.timestamp,
        }
      : null,
    codememb: codememb
      ? {
          totalQueries: codememb.totalQueries,
          topK: codememb.topK,
          semanticAvailable: codememb.semanticAvailable,
          ndcg: codememb.overall.ndcg,
          recall: codememb.overall.recall,
          mrr: codememb.overall.mrr,
          hitRate: codememb.overall.hitRate,
          timestamp: codememb.timestamp,
        }
      : null,
    codemembAblation: codemembAblation
      ? codemembAblation.configurations.map((c) => ({
          name: c.name,
          ndcg: c.ndcg,
          hitRate: c.hitRate,
          deltaNdcg: c.deltaNdcg,
          deltaHitRate: c.deltaHitRate,
        }))
      : null,
    coir: coir
      ? {
          mode: coir.mode,
          model: coir.model,
          subtasksRun: coir.subtasks_run,
          subtasksTotal: coir.subtasks_total,
          meanNdcgAt10: coir.mean_ndcg_at_10,
          meanRecallAt10: coir.mean_recall_at_10,
          meanMapAt10: coir.mean_map_at_10,
          perTask: coir.per_task,
        }
      : null,
  };

  writeFileSync(OUT_PATH, JSON.stringify(combined, null, 2), "utf8");

  if (jsonOnly) {
    console.log(JSON.stringify(combined, null, 2));
    return;
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║              Gyst Benchmark Summary                      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  printHeader("LongMemEval (Hit@5)  — general long-term memory");
  if (longmem) {
    const r = longmem.report;
    console.log(`  Questions:   ${r.totalQuestions}`);
    console.log(`  Hit Rate:    ${fmtPct(r.overall.hitRate)}`);
    console.log(`  MRR@${r.topK}:      ${fmtNum(r.overall.mrrAtK)}`);
    console.log(`  Recall@${r.topK}:   ${fmtNum(r.overall.recallAtK)}`);
  } else {
    console.log("  (not yet run)");
  }

  printHeader("CoIR (ACL 2025)  — code retrieval leaderboard");
  if (coir) {
    console.log(`  Mode:         ${coir.mode}`);
    console.log(`  Model:        ${coir.model}`);
    console.log(
      `  Subtasks:     ${coir.subtasks_run.length} of ${coir.subtasks_total} (${coir.subtasks_run.join(", ")})`,
    );
    console.log(`  Mean NDCG@10:  ${fmtNum(coir.mean_ndcg_at_10)}`);
    console.log(`  Mean Recall@10:${fmtNum(coir.mean_recall_at_10)}`);
    console.log(`  Mean MAP@10:   ${fmtNum(coir.mean_map_at_10)}`);
    console.log("  Per task:");
    for (const [t, m] of Object.entries(coir.per_task)) {
      console.log(
        `    ${t.padEnd(22)} NDCG=${fmtNum(m.ndcg_at_10)}  ` +
          `Recall=${fmtNum(m.recall_at_10)}  MAP=${fmtNum(m.map_at_10)}`,
      );
    }
  } else {
    console.log("  (not yet run — bun run benchmark:coir)");
  }

  printHeader("CodeMemBench  — knowledge about code (Gyst-defined)");
  if (codememb) {
    console.log(`  Queries:     ${codememb.totalQueries}`);
    console.log(`  Semantic:    ${codememb.semanticAvailable ? "enabled" : "disabled"}`);
    console.log(`  NDCG@${codememb.topK}:     ${fmtNum(codememb.overall.ndcg)}`);
    console.log(`  Recall@${codememb.topK}:   ${fmtNum(codememb.overall.recall)}`);
    console.log(`  MRR@${codememb.topK}:      ${fmtNum(codememb.overall.mrr)}`);
    console.log(`  Hit Rate:    ${fmtPct(codememb.overall.hitRate)}`);
    console.log("  (self-built dataset — fairness statement in README)");
  } else {
    console.log("  (not yet run — bun run benchmark:codememb)");
  }

  if (codemembAblation) {
    printHeader("CodeMemBench strategy ablation");
    console.log(
      "  " +
        "config".padEnd(28) +
        "NDCG".padStart(10) +
        "ΔNDCG".padStart(12) +
        "Hit".padStart(10) +
        "ΔHit".padStart(10),
    );
    for (const c of codemembAblation.configurations) {
      const signN = c.deltaNdcg >= 0 ? "+" : "";
      const signH = c.deltaHitRate >= 0 ? "+" : "";
      console.log(
        "  " +
          c.name.padEnd(28) +
          fmtNum(c.ndcg).padStart(10) +
          (signN + fmtNum(c.deltaNdcg)).padStart(12) +
          fmtPct(c.hitRate).padStart(10) +
          (signH + fmtPct(c.deltaHitRate)).padStart(10),
      );
    }
  }

  console.log(`\nWritten: ${OUT_PATH}`);
}

main();
