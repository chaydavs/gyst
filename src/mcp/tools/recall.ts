/**
 * The `recall` MCP tool — agents search team knowledge.
 *
 * Runs three complementary search strategies (file-path, BM25, graph), fuses
 * the results with Reciprocal Rank Fusion, filters by confidence threshold,
 * and returns formatted results within a token budget.
 *
 * The optional `context_budget` parameter allows callers to specify a tighter
 * token budget for self-hosted models (e.g. Ollama with 4096-token context).
 * When omitted, the budget defaults to `config.maxRecallTokens` (5000).
 * Four formatting tiers adapt automatically:
 *   5000+  → full (title, body, files, tags)
 *   2000–4999 → compact (top 3, first 2 sentences)
 *   800–1999  → minimal (top 2, 80-char summary)
 *   < 800     → ultra-minimal (top 1, first sentence)
 */

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

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const RecallInput = z.object({
  query: z.string().min(2).max(500),
  type: z
    .enum(["error_pattern", "convention", "decision", "learning", "ghost_knowledge", "all"])
    .optional()
    .default("all"),
  files: z.array(z.string()).optional().default([]),
  max_results: z.number().min(1).max(10).optional().default(5),
  scope: z.enum(["personal", "team", "project"]).optional(),
  developer_id: z.string().optional(),
  /**
   * Maximum tokens allowed in the formatted response.
   *
   * Use this to adapt recall output to the caller's available context window:
   *   - Claude Code / Cursor: omit (defaults to config.maxRecallTokens = 5000)
   *   - Ollama / small models: 2000
   *   - Ultra-tight contexts:   800–1000
   *
   * Must be between 200 and 20000.
   */
  context_budget: z.number().int().min(200).max(20000).optional(),
});

type RecallInputType = z.infer<typeof RecallInput>;

// ---------------------------------------------------------------------------
// Database row type
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
}

// FormattableEntry is imported from format-recall; EntryRow satisfies its shape.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches full entry data for a list of ids from the database, applying
 * scope-based visibility rules.
 *
 * Visibility rules:
 *  - "team" and "project" scope entries are visible to everyone.
 *  - "personal" scope entries are only visible when `developerId` matches.
 *  - If no `developerId` is provided, only team and project entries are shown.
 *
 * @param db - Open database connection.
 * @param ids - List of entry ids to fetch.
 * @param developerId - Optional caller identity for personal entry access.
 * @returns Array of entry rows in the order the ids were provided.
 */
function fetchEntries(
  db: Database,
  ids: string[],
  developerId?: string,
  includeAllPersonal = false,
): EntryRow[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");

  let sql: string;
  let params: string[];

  if (developerId !== undefined) {
    sql = `
      SELECT id, type, title, content, confidence, scope
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status = 'active'
        AND  (scope IN ('team', 'project')
              OR (scope = 'personal' AND developer_id = ?))
    `;
    params = [...ids, developerId];
  } else if (includeAllPersonal) {
    // Personal mode with no developer_id — single user, all entries are theirs.
    sql = `
      SELECT id, type, title, content, confidence, scope
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status = 'active'
    `;
    params = [...ids];
  } else {
    sql = `
      SELECT id, type, title, content, confidence, scope
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status = 'active'
        AND  scope IN ('team', 'project')
    `;
    params = [...ids];
  }

  const rows = db.query<EntryRow, string[]>(sql).all(...params);

  // Preserve the RRF rank order.
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `recall` tool on the given MCP server.
 *
 * Runs three search strategies in parallel, fuses results via RRF, filters by
 * confidence, and returns formatted knowledge within the configured token budget.
 *
 * The optional `context_budget` parameter overrides `config.maxRecallTokens` so
 * self-hosted models with small context windows (e.g. Ollama @ 4096 tokens) can
 * request a tighter output. Four formatting tiers are selected automatically:
 *   >= 5000  → full (up to 5 entries, title + body + files + tags)
 *   >= 2000  → compact (up to 3 entries, first 2 sentences)
 *   >= 800   → minimal (up to 2 entries, 80-char summary)
 *   < 800    → ultra-minimal (1 entry, first sentence only)
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerRecallTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "recall",
    "Search team knowledge for relevant patterns, conventions, decisions, or learnings. Use this before writing code to surface applicable team context. For token-efficient retrieval, consider `search` + `get_entry` (7× savings): `search` returns a compact index, then call `get_entry` only for the results you want to read in full.",
    RecallInput.shape,
    async (input: RecallInputType) => {
      logger.info("recall tool called", {
        query: input.query,
        type: input.type,
        scope: input.scope,
        developer_id: input.developer_id,
        context_budget: input.context_budget,
      });

      const config = loadConfig();
      const typeFilter = input.type === "all" ? undefined : input.type;
      const developerId = input.developer_id;
      // In personal mode with no developer_id, all stored entries belong to
      // the single user — drop scope filtering entirely so they are visible.
      const includeAllPersonal = ctx.mode === "personal" && developerId === undefined;

      // Resolve the effective token budget: explicit parameter takes priority
      // over the configured default so callers on small context windows can
      // request a reduced output.
      const budget = input.context_budget ?? config.maxRecallTokens;

      // Run all five search strategies in parallel. Semantic is skipped
      // gracefully when the SQLite binary can't load extensions.
      const semanticPromise = canLoadExtensions()
        ? searchByVector(db, input.query, 20, developerId).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("searchByVector failed — falling back", { error: msg });
            return [];
          })
        : Promise.resolve([]);

      const [
        fileResults,
        bm25Results,
        graphResults,
        temporalResults,
        vectorResults,
      ] = await Promise.all([
        Promise.resolve(searchByFilePath(db, input.files ?? [])),
        Promise.resolve(searchByBM25(db, input.query, typeFilter, developerId, includeAllPersonal)),
        Promise.resolve(searchByGraph(db, input.query)),
        Promise.resolve(searchByTemporal(db, input.query)),
        semanticPromise,
      ]);

      logger.debug("Search strategy results", {
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

      // Fuse with Reciprocal Rank Fusion (empty lists are ignored by RRF)
      const rawFused = reciprocalRankFusion([
        fileResults,
        bm25Results,
        graphResults,
        ...temporalWeight,
        vectorResults,
      ]);

      // Filter by minimum confidence (use RRF score as proxy pre-fetch,
      // then re-filter after hydrating with actual confidence values).
      const topIds = rawFused
        .slice(0, (input.max_results ?? 5) * 3) // over-fetch; default 5 when Zod defaults not applied
        .map((r) => r.id);

      const entries = fetchEntries(db, topIds, developerId, includeAllPersonal);

      // Build a score map from the fused results so we can apply the ghost
      // knowledge boost before re-sorting.
      const scoreMap = new Map(rawFused.map((r) => [r.id, r.score]));

      const boostedScores = new Map(
        entries.map((e) => {
          const base = scoreMap.get(e.id) ?? 0;
          let boosted = base;
          if (e.type === "ghost_knowledge") {
            boosted = Math.min(1.0, base + 0.15);
          } else if (e.type === "convention" && (input.files ?? []).length > 0) {
            // Boost conventions relevant to the requested file directories.
            // We don't have entry_files in the fetched rows, so use a small
            // unconditional convention boost when files are provided — the
            // directory-match check happens at the conventions tool layer.
            // Simple heuristic: boost all conventions slightly when files given.
            boosted = Math.min(1.0, base + 0.05);
          }
          return [e.id, boosted] as const;
        }),
      );

      // Apply intent-aware boosting on top of ghost/convention boosts.
      const intentBoostedScores = applyIntentBoost(entries, boostedScores, intent);

      // Sort by priority tier first, then by boosted score within each tier.
      // Tier 0: ghost_knowledge (always surfaces first — mandatory constraints)
      // Tier 1: convention (coding standards relevant to this context)
      // Tier 2: everything else (ordered by score)
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

      // Apply confidence threshold — ghost_knowledge is always included
      // regardless of threshold (confidence is 1.0 by spec, but be explicit
      // here so a misconfigured threshold can never suppress them).
      const filtered = sortedEntries
        .filter(
          (e) =>
            e.type === "ghost_knowledge" ||
            e.confidence >= config.confidenceThreshold,
        )
        .slice(0, input.max_results ?? 5);

      // Record co-retrieval for strengthening over time — best-effort, never throws.
      if (filtered.length >= 2) {
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

      // Prefix ghost_knowledge entry titles with the team-rule warning emoji
      // so agents immediately recognise mandatory constraints.
      const formattableEntries = filtered.map((e) => {
        if (e.type === "ghost_knowledge") {
          return { ...e, title: `⚠️ Team Rule: ${e.title}` };
        }
        if (e.type === "convention") {
          return { ...e, title: `📏 Convention: ${e.title}` };
        }
        return e;
      });

      const formatted = formatForContext(formattableEntries, budget);

      // Log activity when running in team mode with a known developer
      if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "recall", undefined, input.files ?? []);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatted,
          },
        ],
      };
    },
  );
}
