/**
 * The `search` MCP tool — compact knowledge index for efficient browsing.
 *
 * DEPRECATED: prefer `read({ action: "search", ... })`. The registered `search`
 * tool remains for backward compatibility; the core logic is exported as
 * `handleSearch` so the unified `read` tool can dispatch to it.
 *
 * Runs the same 5-strategy search pipeline as recall but returns a compact
 * index (~50 tokens per result): id, type, confidence, age, title.
 * Callers then invoke `read({ action: "get_entry", id })` for full content.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { fetchEntriesByIds } from "../../store/entries.js";
import { loadConfig } from "../../utils/config.js";
import { formatAge } from "../../utils/age.js";
import { logger } from "../../utils/logger.js";
import { emitEvent } from "../../store/events.js";

export const SearchInput = z.object({
  query: z.string().min(2).max(500),
  type: z
    .enum([
      "error_pattern",
      "convention",
      "decision",
      "learning",
      "ghost_knowledge",
      "all",
    ])
    .optional()
    .default("all"),
  limit: z.number().int().min(1).max(50).optional().default(10),
  scope: z.enum(["personal", "team", "project"]).optional(),
  developer_id: z.string().optional(),
});

export type SearchInputType = z.infer<typeof SearchInput>;

/**
 * Executes a compact search. Exported so the unified `read` tool can call it.
 */
export async function handleSearch(
  ctx: ToolContext,
  input: SearchInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  emitEvent(db, "tool_use", { tool: "search", query: input.query });

  logger.info("search called", {
    query: input.query,
    type: input.type,
    limit: input.limit,
    scope: input.scope,
    developer_id: input.developer_id,
  });

  const config = loadConfig();
  const typeFilter = input.type === "all" ? undefined : input.type;
  const developerId = input.developer_id;
  const includeAllPersonal = ctx.mode === "personal" && developerId === undefined;

  const semanticPromise = canLoadExtensions()
    ? searchByVector(db, input.query, 20, developerId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("searchByVector failed — falling back", { error: msg });
        return [];
      })
    : Promise.resolve([]);

  const [fileResults, bm25Results, graphResults, temporalResults, vectorResults] =
    await Promise.all([
      Promise.resolve(searchByFilePath(db, [])),
      Promise.resolve(searchByBM25(db, input.query, typeFilter, developerId, includeAllPersonal)),
      Promise.resolve(searchByGraph(db, input.query)),
      Promise.resolve(searchByTemporal(db, input.query)),
      semanticPromise,
    ]);

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

  const topIds = rawFused.slice(0, input.limit * 3).map((r) => r.id);
  const entries = fetchEntriesByIds(db, topIds, developerId, includeAllPersonal);

  const scoreMap = new Map(rawFused.map((r) => [r.id, r.score]));
  const boostedScores = new Map(
    entries.map((e) => {
      const base = scoreMap.get(e.id) ?? 0;
      let boosted = base;
      if (e.type === "ghost_knowledge") {
        boosted = Math.min(1.0, base + 0.1);
      } else if (e.type === "convention") {
        boosted = Math.min(1.0, base + 0.05);
      }
      return [e.id, boosted] as const;
    }),
  );

  const intentBoostedScores = applyIntentBoost(entries, boostedScores, intent);

  const sortedEntries = [...entries].sort((a, b) => {
    const aIsGhost = a.type === "ghost_knowledge" ? 0 : 1;
    const bIsGhost = b.type === "ghost_knowledge" ? 0 : 1;
    const tierDiff = aIsGhost - bIsGhost;
    if (tierDiff !== 0) return tierDiff;
    return (intentBoostedScores.get(b.id) ?? 0) - (intentBoostedScores.get(a.id) ?? 0);
  });

  const filtered = sortedEntries
    .filter(
      (e) =>
        e.type === "ghost_knowledge" ||
        e.confidence >= config.confidenceThreshold,
    )
    .slice(0, input.limit);

  logger.info("search results", {
    total: entries.length,
    afterFilter: filtered.length,
    confidenceThreshold: config.confidenceThreshold,
  });

  if (filtered.length >= 2) {
    const { recordCoRetrieval } = await import("../../store/graph.js");
    recordCoRetrieval(db, filtered.slice(0, 5).map((e) => e.id));
  }

  if (
    ctx.mode === "team" &&
    ctx.teamId !== undefined &&
    ctx.developerId !== undefined
  ) {
    const { logActivity } = await import("../../server/activity.js");
    logActivity(ctx.db, ctx.teamId, ctx.developerId, "search");
  }

  if (filtered.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No results found for: ${input.query}`,
        },
      ],
    };
  }

  const lines: string[] = [
    `Found ${filtered.length} results. Call read({ action: "get_entry", id }) for full detail.`,
    "",
  ];

  for (const entry of filtered) {
    const confidence = `${(entry.confidence * 100).toFixed(0)}%`;
    const age = formatAge(entry.createdAt);
    lines.push(`${entry.id} · ${entry.type} · ${confidence} · ${age}`);
    lines.push(entry.title);
    lines.push(`ref: gyst://entry/${entry.id}`);
    lines.push("");
  }

  return {
    content: [
      {
        type: "text" as const,
        text: lines.join("\n").trimEnd(),
      },
    ],
  };
}

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "search",
    "[DEPRECATED — use `read` with action: \"search\"] Search team knowledge base and return a compact index. Still functional; will be removed in a future release.",
    SearchInput.shape,
    async (input: SearchInputType) => {
      logger.warn("search tool is deprecated, use `read` with action: \"search\"");
      const result = await handleSearch(ctx, input);
      const prefix = "⚠️ `search` is deprecated — use `read({ action: \"search\", query: ... })`. Forwarding for now.\n\n";
      return {
        content: [{ type: "text" as const, text: prefix + (result.content[0]?.text ?? "") }],
      };
    },
  );
}
