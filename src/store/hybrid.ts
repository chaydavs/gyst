/**
 * Hybrid retrieval helper — composes Gyst's 5 search strategies and fuses
 * them with Reciprocal Rank Fusion.
 *
 * This file exists so that benchmark harnesses (CoIR, CodeMemBench) can
 * reuse the exact same composition that `tests/eval/retrieval-eval.ts`
 * and `src/mcp/tools/recall.ts` perform inline.
 *
 * Strategies, in the order they're added to the fusion pool:
 *   1. File-path lookup      — only when `fileContext` is non-empty
 *   2. BM25 (FTS5)           — optional type filter + developer scope
 *   3. Graph traversal       — tag + file one-hop walk
 *   4. Temporal              — zero-cost no-op when query has no time signal
 *   5. Semantic (sqlite-vec) — graceful degradation via canLoadExtensions()
 *
 * All five feed into reciprocalRankFusion (default k=60).
 *
 * Post-fusion steps:
 *   1. Type-aware boosting (conventions, consolidated entries)
 *   2. Scope-aware boosting (personal memory prioritization)
 *   3. Intent-aware boosting (via applyIntentBoost)
 *   4. Final sort by boosted score
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
import { classifyIntent, applyIntentBoost } from "./intent.js";
import { logger } from "../utils/logger.js";

export interface HybridSearchOptions {
  readonly fileContext?: readonly string[];
  readonly typeFilter?: string;
  readonly developerId?: string;
  readonly includeSemanticCandidateLimit?: number;
  readonly rrfK?: number;
  readonly disableStrategies?: readonly HybridStrategy[];
  readonly useGraphGuidedSearch?: boolean;
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
    useGraphGuidedSearch = false,
  } = opts;

  const disabled = new Set<HybridStrategy>(disableStrategies);
  const rankedLists: RankedResult[][] = [];

  // 1. File-path lookup
  if (!disabled.has("file_path") && fileContext.length > 0) {
    const fileResults = searchByFilePath(db, [...fileContext]);
    if (fileResults.length > 0) {
      rankedLists.push(fileResults);
    }
  }

  // 2. BM25 (FTS5)
  if (!disabled.has("bm25")) {
    const bm25Results = searchByBM25(db, query, typeFilter, developerId);
    if (bm25Results.length > 0) {
      rankedLists.push(bm25Results);
    }
  }

  // 3. Graph traversal
  let graphIds: string[] | undefined;
  if (!disabled.has("graph")) {
    const graphResults = searchByGraph(db, query);
    if (graphResults.length > 0) {
      rankedLists.push(graphResults);
      if (useGraphGuidedSearch) {
        graphIds = graphResults.map((r) => r.id);
      }
    }
  }

  // 4. Temporal
  const intent = classifyIntent(query);
  if (!disabled.has("temporal")) {
    const temporalResults = searchByTemporal(db, query);
    if (temporalResults.length > 0) {
      rankedLists.push(temporalResults);
    }
  }

  // 5. Semantic (sqlite-vec)
  if (!disabled.has("semantic") && canLoadExtensions()) {
    try {
      const vectorResults = await searchByVector(
        db,
        query,
        includeSemanticCandidateLimit,
        developerId,
        graphIds,
      );
      if (vectorResults.length > 0) {
        rankedLists.push(vectorResults);
      } else if (graphIds && graphIds.length > 0) {
        // Fallback to global semantic search
        const globalVectorResults = await searchByVector(
          db,
          query,
          includeSemanticCandidateLimit,
          developerId,
        );
        if (globalVectorResults.length > 0) {
          rankedLists.push(globalVectorResults);
        }
      }
    } catch (err) {
      logger.warn("runHybridSearch: semantic strategy failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Fuse results via Reciprocal Rank Fusion
  const rawFused = reciprocalRankFusion(rankedLists, rrfK);
  if (rawFused.length === 0) {
    return [];
  }

  // 7. Hydrate entry types for boosting and sorting
  const topIds = rawFused.slice(0, 50).map((r) => r.id);
  const placeholders = topIds.map(() => "?").join(", ");
  const entries = db
    .query<{ id: string; type: string; status: string; scope: string; developer_id: string | null }, string[]>(
      `SELECT id, type, status, scope, developer_id FROM entries WHERE id IN (${placeholders})`,
    )
    .all(...topIds);

  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const scoreMap = new Map(rawFused.map((r) => [r.id, r.score]));

  // 8. Apply type-aware, scope-aware, and intent-aware boosts
  const boostedScores = new Map(
    topIds.flatMap((id) => {
      const e = entryMap.get(id);
      if (!e) return [];
      const base = scoreMap.get(id) ?? 0;
      let boosted = base;
      
      // Personal prioritization: your knowledge surfaces slightly higher
      if (developerId && e.scope === "personal" && e.developer_id === developerId) {
        boosted = Math.min(1.0, boosted + 0.05);
      }

      // Relevancy boost for conventions when file context is present
      if (e.type === "convention" && fileContext.length > 0) {
        boosted = Math.min(1.0, boosted + 0.05);
      }
      // Distilled knowledge boost
      if (e.status === "consolidated") {
        boosted = Math.min(1.0, boosted + 0.10);
      }
      return [[id, boosted] as const];
    }),
  );

  const finalScores = applyIntentBoost(
    entries.map((e) => ({ id: e.id, type: e.type })),
    boostedScores,
    intent,
  );

  // 9. Final sort by boosted score
  const sorted = entries
    .map((e) => ({
      id: e.id,
      score: finalScores.get(e.id) ?? 0,
      source: "hybrid",
    }))
    .sort((a, b) => b.score - a.score);

  return sorted;
}
