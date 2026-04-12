/**
 * The `recall` MCP tool — agents search team knowledge.
 *
 * Runs three complementary search strategies (file-path, BM25, graph), fuses
 * the results with Reciprocal Rank Fusion, filters by confidence threshold,
 * and returns formatted results within a token budget.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import {
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  reciprocalRankFusion,
} from "../../store/search.js";
import { loadConfig } from "../../utils/config.js";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const RecallInput = z.object({
  query: z.string().min(2).max(500),
  type: z
    .enum(["error_pattern", "convention", "decision", "learning", "all"])
    .optional()
    .default("all"),
  files: z.array(z.string()).optional().default([]),
  max_results: z.number().min(1).max(10).optional().default(5),
  scope: z.enum(["personal", "team", "project"]).optional(),
  developer_id: z.string().optional(),
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
}

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
): EntryRow[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");

  let sql: string;
  let params: string[];

  if (developerId !== undefined) {
    sql = `
      SELECT id, type, title, content, confidence
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status = 'active'
        AND  (scope IN ('team', 'project')
              OR (scope = 'personal' AND developer_id = ?))
    `;
    params = [...ids, developerId];
  } else {
    sql = `
      SELECT id, type, title, content, confidence
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

/**
 * Formats a list of entry rows as a markdown string suitable for returning to
 * the agent, capped by a token budget.
 *
 * @param entries - Enriched entries to format.
 * @param maxTokens - Maximum token budget for the response.
 * @returns Formatted markdown string.
 */
function formatResults(entries: EntryRow[], maxTokens: number): string {
  if (entries.length === 0) {
    return "No relevant knowledge found.";
  }

  const sections = entries.map((entry) =>
    [
      `## ${entry.title} (confidence: ${entry.confidence.toFixed(2)}, type: ${entry.type})`,
      entry.content,
      "---",
    ].join("\n"),
  );

  const combined = sections.join("\n\n");
  return truncateToTokenBudget(combined, maxTokens);
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
 * @param server - The McpServer instance to register on.
 * @param db - Open bun:sqlite Database.
 */
export function registerRecallTool(server: McpServer, db: Database): void {
  server.tool(
    "recall",
    "Search team knowledge for relevant patterns, conventions, decisions, or learnings. Use this before writing code to surface applicable team context.",
    RecallInput.shape,
    async (input: RecallInputType) => {
      logger.info("recall tool called", {
        query: input.query,
        type: input.type,
        scope: input.scope,
        developer_id: input.developer_id,
      });

      const config = loadConfig();
      const typeFilter = input.type === "all" ? undefined : input.type;
      const developerId = input.developer_id;

      // Run all three search strategies in parallel
      const [fileResults, bm25Results, graphResults] = await Promise.all([
        Promise.resolve(searchByFilePath(db, input.files)),
        Promise.resolve(searchByBM25(db, input.query, typeFilter, developerId)),
        Promise.resolve(searchByGraph(db, input.query)),
      ]);

      logger.debug("Search strategy results", {
        fileResults: fileResults.length,
        bm25Results: bm25Results.length,
        graphResults: graphResults.length,
      });

      // Fuse with Reciprocal Rank Fusion
      const fused = reciprocalRankFusion([fileResults, bm25Results, graphResults]);

      // Filter by minimum confidence (use RRF score as proxy pre-fetch,
      // then re-filter after hydrating with actual confidence values).
      const topIds = fused
        .slice(0, input.max_results * 3) // over-fetch to account for confidence filtering
        .map((r) => r.id);

      const entries = fetchEntries(db, topIds, developerId);

      // Apply confidence threshold and take top N
      const filtered = entries
        .filter((e) => e.confidence >= config.confidenceThreshold)
        .slice(0, input.max_results);

      logger.info("recall results", {
        total: entries.length,
        afterFilter: filtered.length,
        confidenceThreshold: config.confidenceThreshold,
      });

      const formatted = formatResults(filtered, config.maxRecallTokens);

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
