/**
 * The `activity` MCP tool — surface recent team activity relevant to the
 * current working context.
 *
 * Queries the `activity_log` table (a team-collaboration extension) for
 * recent learn/recall events from other developers' agents.  If the table
 * does not exist — i.e. team features have not been configured — a helpful
 * guidance message is returned instead of crashing.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ActivityInput = z.object({
  /** How many hours back to look. Min 1, max 168 (one week). Default 24. */
  hours: z.number().min(1).max(168).optional().default(24),
  /** Optional file paths — activity touching these files is surfaced first. */
  files: z.array(z.string()).optional().default([]),
  /** Restrict results to specific knowledge types. Omit for all types. */
  types: z
    .array(
      z.enum(["error_pattern", "convention", "decision", "learning"]),
    )
    .optional(),
});

type ActivityInputType = z.infer<typeof ActivityInput>;

/** Token budget for the activity tool response. */
const ACTIVITY_TOKEN_BUDGET = 3_000;

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

/** A row returned by the activity_log + entries join query. */
interface ActivityRow {
  readonly id: number;
  readonly developer_id: string | null;
  readonly action: string;
  readonly entry_id: string | null;
  readonly files: string | null;
  readonly timestamp: string;
  readonly title: string | null;
  readonly entry_type: string | null;
  readonly confidence: number | null;
}

/** Result of the sqlite_master existence check. */
interface TableExistsRow {
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the `activity_log` table exists in the database.
 *
 * @param db - Open database connection.
 */
function activityLogTableExists(db: Database): boolean {
  const row = db
    .query<TableExistsRow, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get("activity_log");
  return row !== null;
}

/**
 * Queries recent activity rows from `activity_log`, optionally filtered by
 * knowledge type.
 *
 * @param db - Open database connection.
 * @param hours - How many hours back to query.
 * @param types - Optional type filter applied to the joined `entries` row.
 * @returns Array of activity rows ordered newest-first, capped at 50.
 */
function fetchActivityRows(
  db: Database,
  hours: number,
  types: readonly string[] | undefined,
): ActivityRow[] {
  if (types !== undefined && types.length > 0) {
    const placeholders = types.map(() => "?").join(", ");
    return db
      .query<ActivityRow, [string, ...string[]]>(
        `SELECT al.id, al.developer_id, al.action, al.entry_id,
                al.files, al.timestamp,
                e.title, e.type AS entry_type, e.confidence
         FROM   activity_log al
         LEFT JOIN entries e ON al.entry_id = e.id
         WHERE  al.timestamp > datetime('now', ? || ' hours')
           AND  e.type IN (${placeholders})
         ORDER  BY al.timestamp DESC
         LIMIT  50`,
      )
      .all(`-${hours}`, ...(types as string[]));
  }

  return db
    .query<ActivityRow, [string]>(
      `SELECT al.id, al.developer_id, al.action, al.entry_id,
              al.files, al.timestamp,
              e.title, e.type AS entry_type, e.confidence
       FROM   activity_log al
       LEFT JOIN entries e ON al.entry_id = e.id
       WHERE  al.timestamp > datetime('now', ? || ' hours')
       ORDER  BY al.timestamp DESC
       LIMIT  50`,
    )
    .all(`-${hours}`);
}

/**
 * Scores a single activity row by how many of the `files` filter list it
 * touches.  Rows with no file overlap score 0 and are listed last.
 *
 * @param row - Activity row to score.
 * @param files - Files to check against.
 * @returns Number of matching files.
 */
function fileOverlapScore(
  row: ActivityRow,
  files: readonly string[],
): number {
  if (files.length === 0 || row.files === null) {
    return 0;
  }

  let rowFiles: unknown;
  try {
    rowFiles = JSON.parse(row.files);
  } catch {
    return 0;
  }

  if (!Array.isArray(rowFiles)) {
    return 0;
  }

  const rowFileSet = new Set(rowFiles as string[]);
  return files.filter((f) => rowFileSet.has(f)).length;
}

/**
 * Formats a list of activity rows as a markdown string within the token budget.
 *
 * @param rows - Activity rows to format, already sorted by priority.
 * @param hours - Window used to fetch the rows (for the header).
 * @returns Formatted markdown string, truncated to `ACTIVITY_TOKEN_BUDGET` tokens.
 */
function formatActivityRows(rows: ActivityRow[], hours: number): string {
  const lines = rows.map((row) => {
    const dev = row.developer_id ?? "unknown";
    const title = row.title ?? "(no entry)";
    const entryType = row.entry_type ?? "";
    const confidence =
      row.confidence !== null ? row.confidence.toFixed(2) : "N/A";
    return `[${row.timestamp}] ${dev} ${row.action}: ${title} (${entryType}, confidence: ${confidence})`;
  });

  const body = lines.join("\n");
  const header = `## Recent Team Activity (last ${hours}h)\n\n`;
  return truncateToTokenBudget(header + body, ACTIVITY_TOKEN_BUDGET);
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `activity` tool on the given MCP server.
 *
 * Returns recent team activity from the `activity_log` table. If team features
 * are not configured (table absent) a guidance message is returned.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerActivityTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "activity",
    "Show recent team knowledge activity — what other developers have been learning, what errors were fixed, and what decisions were recorded.",
    ActivityInput.shape,
    async (input: ActivityInputType) => {
      logger.info("activity tool called", {
        hours: input.hours,
        files: input.files,
        types: input.types,
      });

      if (!activityLogTableExists(db)) {
        logger.info("activity_log table not found, returning guidance");
        return {
          content: [
            {
              type: "text" as const,
              text: "Team activity features are not configured. Run `gyst team create` to set up team collaboration.",
            },
          ],
        };
      }

      const rows = fetchActivityRows(db, input.hours, input.types);

      if (rows.length === 0) {
        logger.info("activity tool: no rows found", { hours: input.hours });
        return {
          content: [
            {
              type: "text" as const,
              text: `No team activity in the last ${input.hours} hours.`,
            },
          ],
        };
      }

      // Sort: rows with file overlap first, then by recency (already sorted).
      const sorted =
        input.files.length > 0
          ? [...rows].sort(
              (a, b) =>
                fileOverlapScore(b, input.files) -
                fileOverlapScore(a, input.files),
            )
          : rows;

      logger.info("activity tool results", { count: sorted.length });

      const formatted = formatActivityRows(sorted, input.hours);

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
