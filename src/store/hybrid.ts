/**
 * Hybrid retrieval helper — composes Gyst's 5 search strategies and fuses
 * them with Reciprocal Rank Fusion.
 *
 * This file exists so that benchmark harnesses (CoIR, CodeMemBench) can
 * reuse the exact same composition that `tests/eval/retrieval-eval.ts`
 * and `src/mcp/tools/recall.ts` perform inline. It is *not* wired into
 * those call sites — a later cleanup PR can refactor them to import from
 * here.
 *
 * Strategies, in the order they're added to the fusion pool:
 *   1. File-path lookup      — only when `fileContext` is non-empty
 *   2. BM25 (FTS5)           — optional type filter + developer scope
 *   3. Graph traversal       — tag + file one-hop walk
 *   4. Temporal              — zero-cost no-op when query has no time signal
 *   5. Semantic (sqlite-vec) — graceful degradation via canLoadExtensions()
 *
 * All five feed into reciprocalRankFusion (default k=60).
 */

import type { Database } from "bun:sqlite";
import {
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  searchByTemporal,
  reciprocalRankFusion,
  type RankedResult,
} from "./search.js";
import { searchByVector } from "./embeddings.js";
import { canLoadExtensions } from "./database.js";
import { logger } from "../utils/logger.js";

export interface HybridSearchOptions {
  readonly fileContext?: readonly string[];
  readonly typeFilter?: string;
  readonly developerId?: string;
  readonly includeSemanticCandidateLimit?: number;
  readonly rrfK?: number;
  readonly disableStrategies?: readonly HybridStrategy[];
}

export type HybridStrategy =
  | "file_path"
  | "bm25"
  | "graph"
  | "temporal"
  | "semantic";

/**
 * Run all enabled strategies in order and fuse their ranked lists via RRF.
 *
 * Returns the fused, score-descending list of candidates. Callers slice to
 * their desired top-K.
 *
 * Semantic is conditional on sqlite-vec being loadable; failures are
 * swallowed so an offline or extension-less runtime still returns results
 * from BM25 + graph + temporal.
 */
export async function runHybridSearch(
  db: Database,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<RankedResult[]> {
  const {
    fileContext = [],
    typeFilter,
    developerId,
    includeSemanticCandidateLimit = 20,
    rrfK = 60,
    disableStrategies = [],
  } = opts;

  const disabled = new Set<HybridStrategy>(disableStrategies);
  const rankedLists: RankedResult[][] = [];

  if (!disabled.has("file_path") && fileContext.length > 0) {
    const fileResults = searchByFilePath(db, [...fileContext]);
    if (fileResults.length > 0) {
      rankedLists.push(fileResults);
    }
  }

  if (!disabled.has("bm25")) {
    const bm25Results = searchByBM25(db, query, typeFilter, developerId);
    if (bm25Results.length > 0) {
      rankedLists.push(bm25Results);
    }
  }

  if (!disabled.has("graph")) {
    const graphResults = searchByGraph(db, query);
    if (graphResults.length > 0) {
      rankedLists.push(graphResults);
    }
  }

  if (!disabled.has("temporal")) {
    const temporalResults = searchByTemporal(db, query);
    if (temporalResults.length > 0) {
      rankedLists.push(temporalResults);
    }
  }

  if (!disabled.has("semantic") && canLoadExtensions()) {
    try {
      const vectorResults = await searchByVector(
        db,
        query,
        includeSemanticCandidateLimit,
        developerId,
      );
      if (vectorResults.length > 0) {
        rankedLists.push(vectorResults);
      }
    } catch (err) {
      logger.warn("runHybridSearch: semantic strategy failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return reciprocalRankFusion(rankedLists, rrfK);
}
