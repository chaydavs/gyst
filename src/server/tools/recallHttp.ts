/**
 * HTTP-aware wrapper for the `recall` MCP tool.
 *
 * Delegates to the same search logic as the stdio version and appends an
 * activity log entry so the team can see what knowledge is being queried.
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
import { logActivity } from "../activity.js";
import type { AuthContext } from "../auth.js";

// ---------------------------------------------------------------------------
// Input schema (identical to the stdio version)
// ---------------------------------------------------------------------------

const RecallInput = z.object({
  query: z.string().min(2).max(500),
  type: z
    .enum(["error_pattern", "convention", "decision", "learning", "all"])
    .optional()
    .default("all"),
  files: z.array(z.string()).optional().default([]),
  max_results: z.number().min(1).max(10).optional().default(5),
});

type RecallInputType = z.infer<typeof RecallInput>;

// ---------------------------------------------------------------------------
// Internal row type
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

function fetchEntries(db: Database, ids: readonly string[]): EntryRow[] {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query<EntryRow, string[]>(
      `SELECT id, type, title, content, confidence
       FROM   entries
       WHERE  id IN (${placeholders})
         AND  status = 'active'`,
    )
    .all(...ids);

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return [...ids].flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });
}

function formatResults(entries: readonly EntryRow[], maxTokens: number): string {
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
  return truncateToTokenBudget(sections.join("\n\n"), maxTokens);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `recall` tool on an HTTP-scoped MCP server.
 *
 * Runs three search strategies in parallel, fuses results via RRF, filters by
 * confidence, and returns formatted knowledge within the configured token budget.
 * Also logs activity for the calling developer.
 *
 * @param server  - The McpServer instance to register on.
 * @param db      - Open bun:sqlite Database.
 * @param authCtx - Resolved auth context for the current HTTP session.
 */
export function registerHttpRecallTool(
  server: McpServer,
  db: Database,
  authCtx: AuthContext,
): void {
  server.tool(
    "recall",
    "Search team knowledge for relevant patterns, conventions, decisions, or learnings.",
    RecallInput.shape,
    async (input: RecallInputType) => {
      logger.info("recall tool called (http)", {
        query: input.query,
        type: input.type,
        developerId: authCtx.developerId,
      });

      const config = loadConfig();
      const typeFilter = input.type === "all" ? undefined : input.type;

      const [fileResults, bm25Results, graphResults] = await Promise.all([
        Promise.resolve(searchByFilePath(db, input.files)),
        Promise.resolve(searchByBM25(db, input.query, typeFilter)),
        Promise.resolve(searchByGraph(db, input.query)),
      ]);

      const fused = reciprocalRankFusion([fileResults, bm25Results, graphResults]);

      const topIds = fused
        .slice(0, input.max_results * 3)
        .map((r) => r.id);

      const entries = fetchEntries(db, topIds);

      const filtered = entries
        .filter((e) => e.confidence >= config.confidenceThreshold)
        .slice(0, input.max_results);

      logger.info("recall results (http)", {
        total: entries.length,
        afterFilter: filtered.length,
        developerId: authCtx.developerId,
      });

      // Log activity
      if (authCtx.developerId !== null) {
        logActivity(db, authCtx.teamId, authCtx.developerId, "recall", undefined, input.files);
      }

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
