/**
 * The `status` MCP tool — DEPRECATED.
 *
 * Prefer `admin({ action: "status", ... })`. Core logic is exported as
 * `handleStatus` so the unified `admin` tool can dispatch to it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

export const StatusInput = z.object({
  hours: z.number().min(1).max(48).optional().default(2),
});

export type StatusInputType = z.infer<typeof StatusInput>;

const STATUS_TOKEN_BUDGET = 2_000;

interface ActiveDevRow {
  readonly developer_id: string;
  readonly action_count: number;
  readonly last_seen: string;
  readonly actions: string;
}

interface FileRow {
  readonly file: string;
}

interface TableExistsRow {
  readonly name: string;
}

interface ConflictCountRow {
  readonly count: number;
}

function activityLogTableExists(db: Database): boolean {
  const row = db
    .query<TableExistsRow, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get("activity_log");
  return row !== null;
}

function fetchActiveDevelopers(db: Database, hours: number): ActiveDevRow[] {
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

function fetchConflictCount(db: Database): number {
  const row = db
    .query<ConflictCountRow, []>(
      "SELECT COUNT(*) AS count FROM entries WHERE status = 'conflicted'",
    )
    .get();
  return row?.count ?? 0;
}

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

/**
 * Core status handler, exported so the unified `admin` tool can reuse it.
 */
export async function handleStatus(
  ctx: ToolContext,
  input: StatusInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  logger.info("status called", { hours: input.hours });

  if (!activityLogTableExists(db)) {
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
    return {
      content: [
        {
          type: "text" as const,
          text: `No active developers in the last ${input.hours} hours.`,
        },
      ],
    };
  }

  const devFiles = new Map<string, readonly string[]>();
  for (const dev of activeDevs) {
    const fileRows = fetchDeveloperFiles(db, dev.developer_id, input.hours);
    devFiles.set(
      dev.developer_id,
      fileRows.map((r) => r.file),
    );
  }

  const conflictCount = fetchConflictCount(db);
  const formatted = formatStatus(activeDevs, devFiles, conflictCount, input.hours);

  return { content: [{ type: "text" as const, text: formatted }] };
}

export function registerStatusTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "status",
    "[DEPRECATED — use `admin` with action: \"status\"] See who on the team is currently active and what they're working on. Still functional; will be removed in a future release.",
    StatusInput.shape,
    async (input: StatusInputType) => {
      logger.warn('status tool is deprecated, use `admin` with action: "status"');
      const result = await handleStatus(ctx, input);
      const prefix =
        '⚠️ `status` is deprecated — use `admin({ action: "status", ... })`. Forwarding for now.\n\n';
      return {
        content: [
          { type: "text" as const, text: prefix + (result.content[0]?.text ?? "") },
        ],
      };
    },
  );
}
