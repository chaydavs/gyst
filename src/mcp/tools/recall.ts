/**
 * The `recall` MCP tool — agents search team knowledge and get full content.
 *
 * DEPRECATED: prefer `read({ action: "recall", ... })`. The registered `recall`
 * tool remains for backward compatibility and emits a deprecation prefix. The
 * core logic is exported as `handleRecall` so the unified `read` tool can reuse it.
 *
 * Runs five search strategies in parallel (file-path, BM25, graph, temporal,
 * vector), fuses the results with Reciprocal Rank Fusion, filters by
 * confidence, and returns formatted results within a token budget.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import type { ToolContext } from "../register-tools.js";
import {
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  searchByTemporal,
  reciprocalRankFusion,
} from "../../store/search.js";
import { canLoadExtensions } from "../../store/database.js";
import { searchByVector } from "../../store/embeddings.js";
import { loadConfig } from "../../utils/config.js";
import { formatForContext } from "../../utils/format-recall.js";
import { logger } from "../../utils/logger.js";
import { emitEvent } from "../../store/events.js";
import { getStructuralForEntries } from "../../store/structural.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const RecallInput = z.object({
  query: z.string().min(2).max(500),
  type: z
    .enum(["error_pattern", "convention", "decision", "learning", "ghost_knowledge", "all"])
    .optional()
    .default("all"),
  files: z.array(z.string()).optional().default([]),
  max_results: z.number().min(1).max(10).optional().default(5),
  scope: z.enum(["personal", "team", "project"]).optional(),
  developer_id: z.string().optional(),
  context_budget: z.number().int().min(200).max(20000).optional(),
});

export type RecallInputType = z.infer<typeof RecallInput>;

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  status: string;
}

function countWikiFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countWikiFiles(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      count += 1;
    }
  }
  return count;
}

function fetchEntries(
  db: Database,
  ids: string[],
  developerId?: string,
  includeAllPersonal = false,
): EntryRow[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(", ");
  let sql: string;
  let params: string[];

  if (developerId !== undefined) {
    sql = `
      SELECT id, type, title, content, confidence, scope, status
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status IN ('active', 'consolidated')
        AND  (scope IN ('team', 'project')
              OR (scope = 'personal' AND developer_id = ?))
    `;
    params = [...ids, developerId];
  } else if (includeAllPersonal) {
    sql = `
      SELECT id, type, title, content, confidence, scope, status
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status IN ('active', 'consolidated')
    `;
    params = [...ids];
  } else {
    sql = `
      SELECT id, type, title, content, confidence, scope, status
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status IN ('active', 'consolidated')
        AND  scope IN ('team', 'project')
    `;
    params = [...ids];
  }

  const rows = db.query<EntryRow, string[]>(sql).all(...params);
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });
}

// ---------------------------------------------------------------------------
// Core handler — reused by the unified `read` tool
// ---------------------------------------------------------------------------

/**
 * Executes a recall. Exported so the unified `read` tool can dispatch to it.
 */
export async function handleRecall(
  ctx: ToolContext,
  input: RecallInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  emitEvent(db, "tool_use", { tool: "recall", query: input.query });

  logger.info("recall called", {
    query: input.query,
    type: input.type,
    scope: input.scope,
    developer_id: input.developer_id,
    context_budget: input.context_budget,
  });

  const config = loadConfig();
  const typeFilter = input.type === "all" ? undefined : input.type;
  const developerId = input.developer_id;
  const includeAllPersonal = ctx.mode === "personal" && developerId === undefined;
  const budget = input.context_budget ?? config.maxRecallTokens;

  const semanticPromise = canLoadExtensions()
    ? searchByVector(db, input.query, 20, developerId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("searchByVector failed — falling back", { error: msg });
        return [];
      })
    : Promise.resolve([]);

  const [fileResults, bm25Results, graphResults, temporalResults, vectorResults] =
    await Promise.all([
      Promise.resolve(searchByFilePath(db, input.files ?? [])),
      Promise.resolve(searchByBM25(db, input.query, typeFilter, developerId, includeAllPersonal)),
      Promise.resolve(searchByGraph(db, input.query)),
      Promise.resolve(searchByTemporal(db, input.query)),
      semanticPromise,
    ]);

  logger.debug("search strategy results", {
    fileResults: fileResults.length,
    bm25Results: bm25Results.length,
    graphResults: graphResults.length,
    temporalResults: temporalResults.length,
    vectorResults: vectorResults.length,
  });

  const { classifyIntent, applyIntentBoost } = await import("../../store/intent.js");
  const intent = classifyIntent(input.query);
  const temporalWeight = (intent === "debugging" || intent === "history")
    ? [temporalResults, temporalResults]
    : [temporalResults];

  const rawFused = reciprocalRankFusion([
    fileResults,
    bm25Results,
    graphResults,
    ...temporalWeight,
    vectorResults,
  ]);

  const topIds = rawFused
    .slice(0, (input.max_results ?? 5) * 3)
    .map((r) => r.id);

  const entries = fetchEntries(db, topIds, developerId, includeAllPersonal);

  const scoreMap = new Map(rawFused.map((r) => [r.id, r.score]));
  const boostedScores = new Map(
    entries.map((e) => {
      const base = scoreMap.get(e.id) ?? 0;
      let boosted = base;
      if (e.type === "ghost_knowledge") {
        boosted = Math.min(1.0, base + 0.15);
      } else if (e.type === "convention" && (input.files ?? []).length > 0) {
        boosted = Math.min(1.0, base + 0.05);
      }
      if (e.status === "consolidated") {
        boosted = Math.min(1.0, boosted + 0.10);
      }
      return [e.id, boosted] as const;
    }),
  );

  const intentBoostedScores = applyIntentBoost(entries, boostedScores, intent);

  const tierOf = (type: string): number => {
    if (type === "ghost_knowledge") return 0;
    if (type === "convention") return 1;
    return 2;
  };

  const sortedEntries = [...entries].sort((a, b) => {
    const tierDiff = tierOf(a.type) - tierOf(b.type);
    if (tierDiff !== 0) return tierDiff;
    return (intentBoostedScores.get(b.id) ?? 0) - (intentBoostedScores.get(a.id) ?? 0);
  });

  let filtered = sortedEntries
    .filter(
      (e) =>
        e.type === "ghost_knowledge" ||
        e.confidence >= config.confidenceThreshold,
    )
    .slice(0, input.max_results ?? 5);

  let isGlobalResult = false;
  if (filtered.length === 0 && ctx.globalDb) {
    logger.info("Local recall yields no results, checking global memory");
    const [gBm25, gVec] = await Promise.all([
      Promise.resolve(searchByBM25(ctx.globalDb, input.query, typeFilter, undefined, true)),
      canLoadExtensions() ? searchByVector(ctx.globalDb, input.query, 5, undefined) : Promise.resolve([])
    ]);

    const gFused = reciprocalRankFusion([gBm25, gVec]);
    if (gFused.length > 0) {
      const gTopIds = gFused.slice(0, input.max_results ?? 5).map(r => r.id);
      const gEntries = fetchEntries(ctx.globalDb, gTopIds, undefined, true);
      if (gEntries.length > 0) {
        filtered = gEntries;
        isGlobalResult = true;
      }
    }
  }

  if (filtered.length >= 2 && !isGlobalResult) {
    try {
      const { recordCoRetrieval } = await import("../../store/graph.js");
      recordCoRetrieval(db, filtered.slice(0, 5).map((e) => e.id));
    } catch (err) {
      logger.warn("recordCoRetrieval failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("recall results", {
    total: entries.length,
    afterFilter: filtered.length,
    confidenceThreshold: config.confidenceThreshold,
    budget,
  });

  const formattableEntries = filtered.map((e) => {
    let titlePrefix = "";
    if (isGlobalResult) titlePrefix = "🌎 Global Memory: ";

    if (e.type === "ghost_knowledge") {
      return { ...e, title: `${titlePrefix}⚠️ Team Rule: ${e.title}` };
    }
    if (e.type === "convention") {
      return { ...e, title: `${titlePrefix}📏 Convention: ${e.title}` };
    }
    return { ...e, title: `${titlePrefix}${e.title}` };
  });

  let formatted = formatForContext(formattableEntries, budget);

  if (!isGlobalResult && filtered.length > 0 && budget >= 1500) {
    try {
      const topIds = filtered.slice(0, 5).map((e) => e.id);
      const adjacent = getStructuralForEntries(db, topIds, input.files ?? [], 5);
      if (adjacent.length > 0) {
        const lines = adjacent.map(
          (s) =>
            `  • ${s.label}${s.sourceLocation ? ` @${s.sourceLocation}` : ""} — ${s.filePath}`,
        );
        formatted +=
          "\n\n📐 Structural context (graphify, adjacent — not ranked):\n" +
          lines.join("\n");
      }
    } catch (err) {
      logger.warn("recall: structural adjacent lookup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (filtered.length === 0 && input.query.length > 5) {
    const wikiDir = loadConfig().wikiDir;
    const fileCount = countWikiFiles(wikiDir);
    const dbCount =
      (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries WHERE status = 'active'").get()?.n ?? 0);
    if (fileCount > dbCount) {
      formatted +=
        "\n\n⚠️ Knowledge base may be stale (wiki has more files than the index). Run 'gyst rebuild' or restart your agent.";
    }
  }

  if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
    const { logActivity } = await import("../../server/activity.js");
    logActivity(ctx.db, ctx.teamId, ctx.developerId, "recall", undefined, input.files ?? []);
  }

  return {
    content: [{ type: "text" as const, text: formatted }],
  };
}

// ---------------------------------------------------------------------------
// Legacy registration — kept for backward compat with a deprecation prefix.
// ---------------------------------------------------------------------------

export function registerRecallTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "recall",
    "[DEPRECATED — use `read` with action: \"recall\"] Search team knowledge and return full entry content. Still functional; will be removed in a future release.",
    RecallInput.shape,
    async (input: RecallInputType) => {
      logger.warn("recall tool is deprecated, use `read` with action: \"recall\"");
      const result = await handleRecall(ctx, input);
      const prefix = "⚠️ `recall` is deprecated — use `read({ action: \"recall\", query: ... })`. Forwarding for now.\n\n";
      return {
        content: [{ type: "text" as const, text: prefix + (result.content[0]?.text ?? "") }],
      };
    },
  );
}
