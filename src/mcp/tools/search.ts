/**
 * The `search` MCP tool — compact knowledge index for efficient browsing.
 *
 * Runs the same 5-strategy search pipeline as `recall` but returns a compact
 * index (~50 tokens per result) showing id, type, confidence, age, and title.
 * Callers can then invoke `get_entry(id)` for full content on specific entries.
 *
 * This is ~7× more token-efficient than `recall` when browsing multiple entries.
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

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const SearchInput = z.object({
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

type SearchInputType = z.infer<typeof SearchInput>;

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `search` tool on the given MCP server.
 *
 * Returns a compact index of matching knowledge entries. Each result is two
 * lines: a metadata line (id · type · confidence · age) and the entry title.
 * Call `get_entry(id)` to read the full content of any result.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx    - Tool context containing db, mode, and optional team identifiers.
 */
export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;

  server.tool(
    "search",
    "Find team knowledge entries by query. Returns a compact index (~50 tokens) showing id, type, confidence, age, and title. Call get_entry(id) to read the full content of any result. 7× more token-efficient than recall for browsing multiple entries.",
    SearchInput.shape,
    async (input: SearchInputType) => {
      logger.info("search tool called", {
        query: input.query,
        type: input.type,
        limit: input.limit,
        scope: input.scope,
        developer_id: input.developer_id,
      });

      const config = loadConfig();
      const typeFilter = input.type === "all" ? undefined : input.type;
      const developerId = input.developer_id;
      // In personal mode with no developer_id, all stored entries belong to
      // the single user — drop scope filtering entirely so they are visible.
      const includeAllPersonal = ctx.mode === "personal" && developerId === undefined;

      // Run all five search strategies in parallel. Vector search is skipped
      // gracefully when the SQLite binary cannot load extensions.
      const semanticPromise = canLoadExtensions()
        ? searchByVector(db, input.query, 20, developerId).catch(
            (err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn("searchByVector failed — falling back", {
                error: msg,
              });
              return [];
            },
          )
        : Promise.resolve([]);

      const [fileResults, bm25Results, graphResults, temporalResults, vectorResults] =
        await Promise.all([
          Promise.resolve(searchByFilePath(db, [])),
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

      // Classify intent to weight temporal results and apply per-type boosts.
      const { classifyIntent, applyIntentBoost } = await import("../../store/intent.js");
      const intent = classifyIntent(input.query);
      // For debugging/history intents, double-weight temporal results (rank-based cheapest weighting).
      const temporalWeight = (intent === "debugging" || intent === "history")
        ? [temporalResults, temporalResults]
        : [temporalResults];

      // Fuse with Reciprocal Rank Fusion (empty lists are ignored by RRF).
      const rawFused = reciprocalRankFusion([
        fileResults,
        bm25Results,
        graphResults,
        ...temporalWeight,
        vectorResults,
      ]);

      // Over-fetch to account for confidence filtering downstream.
      const topIds = rawFused
        .slice(0, input.limit * 3)
        .map((r) => r.id);

      const entries = fetchEntriesByIds(db, topIds, developerId, includeAllPersonal);

      // Build score map and apply ghost/convention boosts.
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

      // Apply intent-aware boosting on top of ghost/convention boosts.
      const intentBoostedScores = applyIntentBoost(entries, boostedScores, intent);

      // Re-sort: ghost_knowledge first, then by intent-boosted score.
      const sortedEntries = [...entries].sort((a, b) => {
        const aIsGhost = a.type === "ghost_knowledge" ? 0 : 1;
        const bIsGhost = b.type === "ghost_knowledge" ? 0 : 1;
        const tierDiff = aIsGhost - bIsGhost;
        if (tierDiff !== 0) return tierDiff;
        return (intentBoostedScores.get(b.id) ?? 0) - (intentBoostedScores.get(a.id) ?? 0);
      });

      // Apply confidence threshold — ghost_knowledge is always included.
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

      // Record co-retrieval for connection strengthening
      if (filtered.length >= 2) {
        const { recordCoRetrieval } = await import("../../store/graph.js");
        recordCoRetrieval(db, filtered.slice(0, 5).map((e) => e.id));
      }

      // Log activity when running in team mode with a known developer.
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

      // Build compact index: two lines per entry, separated by blank lines.
      const lines: string[] = [
        `Found ${filtered.length} results. Call get_entry({id}) for full detail.`,
        "",
      ];

      for (const entry of filtered) {
        const confidence = `${(entry.confidence * 100).toFixed(0)}%`;
        const age = formatAge(entry.createdAt);
        lines.push(`${entry.id} · ${entry.type} · ${confidence} · ${age}`);
        lines.push(entry.title);
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
    },
  );
}
