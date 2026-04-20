/**
 * The `activity` MCP tool — DEPRECATED.
 *
 * Prefer `admin({ action: "activity", ... })`. Core logic is exported as
 * `handleActivity` so the unified `admin` tool can dispatch to it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

export const ActivityInput = z.object({
  hours: z.number().min(1).max(168).optional().default(24),
  files: z.array(z.string()).optional().default([]),
  types: z
    .array(z.enum(["error_pattern", "convention", "decision", "learning"]))
    .optional(),
});

export type ActivityInputType = z.infer<typeof ActivityInput>;

const ACTIVITY_TOKEN_BUDGET = 3_000;

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

interface TableExistsRow {
  readonly name: string;
}

function activityLogTableExists(db: Database): boolean {
  const row = db
    .query<TableExistsRow, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get("activity_log");
  return row !== null;
}

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

function fileOverlapScore(row: ActivityRow, files: readonly string[]): number {
  if (files.length === 0 || row.files === null) return 0;

  let rowFiles: unknown;
  try {
    rowFiles = JSON.parse(row.files);
  } catch {
    return 0;
  }
  if (!Array.isArray(rowFiles)) return 0;
  const rowFileSet = new Set(rowFiles as string[]);
  return files.filter((f) => rowFileSet.has(f)).length;
}

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

/**
 * Core activity handler, exported so the unified `admin` tool can reuse it.
 */
export async function handleActivity(
  ctx: ToolContext,
  input: ActivityInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  logger.info("activity called", {
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
    return {
      content: [
        {
          type: "text" as const,
          text: `No team activity in the last ${input.hours} hours.`,
        },
      ],
    };
  }

  const sorted =
    input.files.length > 0
      ? [...rows].sort(
          (a, b) =>
            fileOverlapScore(b, input.files) -
            fileOverlapScore(a, input.files),
        )
      : rows;

  const formatted = formatActivityRows(sorted, input.hours);

  return { content: [{ type: "text" as const, text: formatted }] };
}

export function registerActivityTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "activity",
    "[DEPRECATED — use `admin` with action: \"activity\"] Show recent team knowledge activity. Still functional; will be removed in a future release.",
    ActivityInput.shape,
    async (input: ActivityInputType) => {
      logger.warn('activity tool is deprecated, use `admin` with action: "activity"');
      const result = await handleActivity(ctx, input);
      const prefix =
        '⚠️ `activity` is deprecated — use `admin({ action: "activity", ... })`. Forwarding for now.\n\n';
      return {
        content: [
          { type: "text" as const, text: prefix + (result.content[0]?.text ?? "") },
        ],
      };
    },
  );
}
