/**
 * The `status` MCP tool — show who on the team is currently active and what
 * they are working on.
 *
 * Queries the `activity_log` table (a team-collaboration extension) for
 * distinct developers who have had activity in the last N hours, then
 * augments each developer's entry with the files they have been touching.
 * If the table does not exist — i.e. team features have not been configured —
 * a helpful guidance message is returned instead of crashing.
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

const StatusInput = z.object({
  /** How many hours back to look for team status. Min 1, max 48. Default 2. */
  hours: z.number().min(1).max(48).optional().default(2),
  /**
   * When provided, append an activity log section to the output.
   * activity_hours: how far back to look for activity (1–168h, default 24).
   */
  activity_hours: z.number().min(1).max(168).optional(),
  /** Restrict activity log to a specific developer. */
  developer_id: z.string().optional(),
  /** Restrict activity log to a specific action type. */
  action: z.string().optional(),
});

type StatusInputType = z.infer<typeof StatusInput>;

/** Token budget for the status tool response. */
const STATUS_TOKEN_BUDGET = 2_000;

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

/** A row returned by the active-developers aggregation query. */
interface ActiveDevRow {
  readonly developer_id: string;
  readonly action_count: number;
  readonly last_seen: string;
  readonly actions: string;
}

/** A row returned by the per-developer file query. */
interface FileRow {
  readonly file: string;
}

/** Result of the sqlite_master existence check. */
interface TableExistsRow {
  readonly name: string;
}

/** Result of the conflicted-entries count query. */
interface ConflictCountRow {
  readonly count: number;
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
 * Fetches all developers who have had activity within the given time window.
 *
 * @param db - Open database connection.
 * @param hours - How many hours back to look.
 * @returns Array of active developer rows ordered by most-recent activity.
 */
function fetchActiveDevelopers(
  db: Database,
  hours: number,
): ActiveDevRow[] {
  return db
    .query<ActiveDevRow, [string]>(
      `SELECT developer_id,
              COUNT(*)                    AS action_count,
              MAX(timestamp)             AS last_seen,
              GROUP_CONCAT(DISTINCT action) AS actions
       FROM   activity_log
       WHERE  timestamp > datetime('now', ? || ' hours')
       GROUP  BY developer_id
       ORDER  BY last_seen DESC`,
    )
    .all(`-${hours}`);
}

/**
 * Returns the distinct file paths a developer has touched in the time window.
 *
 * The `files` column in `activity_log` is expected to be a JSON array string.
 * Uses SQLite's `json_each` table-valued function to unnest the array.
 *
 * @param db - Open database connection.
 * @param developerId - The developer to query.
 * @param hours - How many hours back to look.
 * @returns Array of file rows (up to 10 distinct paths).
 */
function fetchDeveloperFiles(
  db: Database,
  developerId: string,
  hours: number,
): FileRow[] {
  return db
    .query<FileRow, [string, string]>(
      `SELECT DISTINCT json_each.value AS file
       FROM   activity_log, json_each(activity_log.files)
       WHERE  developer_id = ?
         AND  timestamp > datetime('now', ? || ' hours')
         AND  files IS NOT NULL
       LIMIT  10`,
    )
    .all(developerId, `-${hours}`);
}

/**
 * Returns the number of entries currently in a `conflicted` status.
 *
 * @param db - Open database connection.
 */
function fetchConflictCount(db: Database): number {
  const row = db
    .query<ConflictCountRow, []>(
      "SELECT COUNT(*) AS count FROM entries WHERE status = 'conflicted'",
    )
    .get();
  return row?.count ?? 0;
}

/**
 * Formats the active-developer list into a markdown string within the token
 * budget.
 *
 * @param devs - Active developer rows.
 * @param devFiles - Map from developer_id to their recent file list.
 * @param conflictCount - Number of conflicted entries (shown as a warning).
 * @param hours - Window used (for the header).
 * @returns Formatted markdown string, truncated to `STATUS_TOKEN_BUDGET` tokens.
 */
function formatStatus(
  devs: ActiveDevRow[],
  devFiles: ReadonlyMap<string, readonly string[]>,
  conflictCount: number,
  hours: number,
): string {
  const sections: string[] = [
    `## Team Status (last ${hours}h)`,
    "",
    `Active developers: ${devs.length}`,
    "",
  ];

  for (const dev of devs) {
    const files = devFiles.get(dev.developer_id) ?? [];
    const fileList = files.length > 0 ? files.join(", ") : "no specific files";
    sections.push(
      `### ${dev.developer_id}`,
      `- Last seen: ${dev.last_seen}`,
      `- Actions: ${dev.actions} (${dev.action_count} total)`,
      `- Working on: ${fileList}`,
      "",
    );
  }

  if (conflictCount > 0) {
    sections.push(
      `**${conflictCount} conflicting ${conflictCount === 1 ? "entry" : "entries"} need resolution.**`,
    );
  }

  return truncateToTokenBudget(sections.join("\n"), STATUS_TOKEN_BUDGET);
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `status` tool on the given MCP server.
 *
 * Returns who on the team is currently active and what files/modules they are
 * working on.  If team features are not configured (table absent) a guidance
 * message is returned.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerStatusTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "status",
    "Health check, team status, and optional activity log. Shows KB stats, active developers, and conflicts. Pass activity_hours to append recent team activity (learn/recall events). Optionally filter by developer_id or action.",
    StatusInput.shape,
    async (input: StatusInputType) => {
      logger.info("status tool called", { hours: input.hours, activity_hours: input.activity_hours });

      if (!activityLogTableExists(db)) {
        logger.info("activity_log table not found, returning guidance");
        return {
          content: [
            {
              type: "text" as const,
              text: "Team status features are not configured. Run `gyst team create` to set up team collaboration.",
            },
          ],
        };
      }

      const activeDevs = fetchActiveDevelopers(db, input.hours);

      if (activeDevs.length === 0) {
        logger.info("status tool: no active developers", {
          hours: input.hours,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `No active developers in the last ${input.hours} hours.`,
            },
          ],
        };
      }

      // Collect file lists for each active developer.
      const devFiles = new Map<string, readonly string[]>();
      for (const dev of activeDevs) {
        const fileRows = fetchDeveloperFiles(db, dev.developer_id, input.hours);
        devFiles.set(
          dev.developer_id,
          fileRows.map((r) => r.file),
        );
      }

      const conflictCount = fetchConflictCount(db);

      logger.info("status tool results", {
        activeDevelopers: activeDevs.length,
        conflictCount,
      });

      let formatted = formatStatus(activeDevs, devFiles, conflictCount, input.hours);

      // --- Optional activity log section ---
      if (input.activity_hours !== undefined && activityLogTableExists(db)) {
        const actHours = input.activity_hours;

        // Build dynamic query with optional developer_id / action filters
        const conditions: string[] = [`al.timestamp > datetime('now', ? || ' hours')`];
        const params: (string | number)[] = [`-${actHours}`];

        if (input.developer_id !== undefined) {
          conditions.push("al.developer_id = ?");
          params.push(input.developer_id);
        }
        if (input.action !== undefined) {
          conditions.push("al.action = ?");
          params.push(input.action);
        }

        interface ActivityRow {
          readonly developer_id: string | null;
          readonly action: string;
          readonly entry_id: string | null;
          readonly files: string | null;
          readonly timestamp: string;
          readonly title: string | null;
          readonly entry_type: string | null;
          readonly confidence: number | null;
        }

        const actRows = db
          .query<ActivityRow, (string | number)[]>(
            `SELECT al.developer_id, al.action, al.entry_id,
                    al.files, al.timestamp,
                    e.title, e.type AS entry_type, e.confidence
             FROM   activity_log al
             LEFT JOIN entries e ON al.entry_id = e.id
             WHERE  ${conditions.join(" AND ")}
             ORDER  BY al.timestamp DESC
             LIMIT  50`,
          )
          .all(...params);

        if (actRows.length > 0) {
          const actLines = actRows.map((row) => {
            const dev = row.developer_id ?? "unknown";
            const title = row.title ?? "(no entry)";
            const entryType = row.entry_type ?? "";
            const confidence = row.confidence !== null ? row.confidence.toFixed(2) : "N/A";
            return `[${row.timestamp}] ${dev} ${row.action}: ${title} (${entryType}, confidence: ${confidence})`;
          });
          formatted += `\n\n## Recent Activity (last ${actHours}h)\n\n${actLines.join("\n")}`;
        } else {
          formatted += `\n\n## Recent Activity (last ${actHours}h)\n\nNo activity found.`;
        }
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
