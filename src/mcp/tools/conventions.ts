/**
 * The `conventions` MCP tool — surface team coding standards for the current
 * context.
 *
 * Queries entries of type `"convention"` from SQLite, filtered by matching
 * file paths or tags when provided. Returns formatted conventions within the
 * configured token budget.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { loadConfig } from "../../utils/config.js";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ConventionsInput = z.object({
  directory: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

type ConventionsInputType = z.infer<typeof ConventionsInput>;

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface ConventionRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches active conventions from the database, optionally filtered by
 * directory prefix (file path) or tags.
 *
 * When both `directory` and `tags` are provided, results satisfying **either**
 * filter are returned (union semantics).
 *
 * @param db - Open database connection.
 * @param directory - Optional directory prefix to match against entry_files paths.
 * @param tags - Optional list of tags to filter on.
 * @returns Array of matching convention rows ordered by descending confidence.
 */
function fetchConventions(
  db: Database,
  directory: string | undefined,
  tags: string[] | undefined,
): ConventionRow[] {
  const hasDirectory = directory !== undefined && directory.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;

  // When no filter is given, return all active conventions.
  if (!hasDirectory && !hasTags) {
    return db
      .query<ConventionRow, []>(
        `SELECT e.id, e.title, e.content, e.confidence
         FROM   entries e
         WHERE  e.type   = 'convention'
           AND  e.status = 'active'
         ORDER  BY e.confidence DESC`,
      )
      .all();
  }

  const conditions: string[] = ["e.type = 'convention'", "e.status = 'active'"];
  const params: string[] = [];
  const joins: string[] = [];

  if (hasDirectory) {
    joins.push("LEFT JOIN entry_files ef ON ef.entry_id = e.id");
    conditions.push("ef.file_path LIKE ?");
    params.push(`${directory}%`);
  }

  if (hasTags) {
    joins.push("LEFT JOIN entry_tags et ON et.entry_id = e.id");
    const tagPlaceholders = tags!.map(() => "?").join(", ");
    conditions.push(`et.tag IN (${tagPlaceholders})`);
    params.push(...tags!);
  }

  const sql = `
    SELECT DISTINCT e.id, e.title, e.content, e.confidence
    FROM   entries e
    ${joins.join("\n    ")}
    WHERE  ${conditions.join("\n      AND  ")}
    ORDER  BY e.confidence DESC
  `;

  return db.query<ConventionRow, string[]>(sql).all(...params);
}

/**
 * Formats convention rows into a markdown string within a token budget.
 *
 * @param rows - Convention rows to format.
 * @param maxTokens - Maximum token budget.
 * @returns Formatted markdown string.
 */
function formatConventions(rows: ConventionRow[], maxTokens: number): string {
  if (rows.length === 0) {
    return "No conventions found for the given context.";
  }

  const sections = rows.map((row) =>
    [
      `## ${row.title} (confidence: ${row.confidence.toFixed(2)})`,
      row.content,
      "---",
    ].join("\n"),
  );

  return truncateToTokenBudget(sections.join("\n\n"), maxTokens);
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `conventions` tool on the given MCP server.
 *
 * Returns team coding standards that apply to the current directory or tags.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerConventionsTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "conventions",
    "Get team coding standards and conventions relevant to the current context. Optionally filter by directory or tags.",
    ConventionsInput.shape,
    async (input: ConventionsInputType) => {
      logger.info("conventions tool called", {
        directory: input.directory,
        tags: input.tags,
      });

      const config = loadConfig();
      const rows = fetchConventions(db, input.directory, input.tags);

      logger.info("conventions results", { count: rows.length });

      // Log activity when running in team mode with a known developer
      if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "conventions");
      }

      const formatted = formatConventions(rows, config.maxRecallTokens);

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
