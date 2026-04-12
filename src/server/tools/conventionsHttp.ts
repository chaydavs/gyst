/**
 * HTTP-aware wrapper for the `conventions` MCP tool.
 *
 * Delegates to the same conventions query logic as the stdio version and
 * appends an activity log entry for the calling developer.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { loadConfig } from "../../utils/config.js";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import { logActivity } from "../activity.js";
import type { AuthContext } from "../auth.js";

// ---------------------------------------------------------------------------
// Input schema (identical to the stdio version)
// ---------------------------------------------------------------------------

const ConventionsInput = z.object({
  directory: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

type ConventionsInputType = z.infer<typeof ConventionsInput>;

// ---------------------------------------------------------------------------
// Internal row type
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

function fetchConventions(
  db: Database,
  directory: string | undefined,
  tags: readonly string[] | undefined,
): ConventionRow[] {
  const hasDirectory = directory !== undefined && directory.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;

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

  if (hasTags && tags !== undefined) {
    joins.push("LEFT JOIN entry_tags et ON et.entry_id = e.id");
    const tagPlaceholders = tags.map(() => "?").join(", ");
    conditions.push(`et.tag IN (${tagPlaceholders})`);
    params.push(...tags);
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

function formatConventions(rows: readonly ConventionRow[], maxTokens: number): string {
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
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `conventions` tool on an HTTP-scoped MCP server.
 *
 * Returns team coding standards that apply to the current directory or tags,
 * and logs the query as activity for the calling developer.
 *
 * @param server  - The McpServer instance to register on.
 * @param db      - Open bun:sqlite Database.
 * @param authCtx - Resolved auth context for the current HTTP session.
 */
export function registerHttpConventionsTool(
  server: McpServer,
  db: Database,
  authCtx: AuthContext,
): void {
  server.tool(
    "conventions",
    "Get team coding standards and conventions relevant to the current context.",
    ConventionsInput.shape,
    async (input: ConventionsInputType) => {
      logger.info("conventions tool called (http)", {
        directory: input.directory,
        tags: input.tags,
        developerId: authCtx.developerId,
      });

      const config = loadConfig();
      const rows = fetchConventions(db, input.directory, input.tags);

      logger.info("conventions results (http)", {
        count: rows.length,
        developerId: authCtx.developerId,
      });

      // Log activity
      if (authCtx.developerId !== null) {
        logActivity(db, authCtx.teamId, authCtx.developerId, "conventions");
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
