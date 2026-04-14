/**
 * The `check_conventions` MCP tool — surface team coding conventions that
 * apply to a specific file or directory path.
 *
 * Queries entries of type `"convention"` from SQLite, matching by file path
 * prefix (entry_files) and by directory-level tag fallback. Results from both
 * strategies are merged, deduplicated by id, and sorted by confidence desc.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const CheckConventionsInput = z.object({
  file_path: z.string().min(1).max(1000),
});

type CheckConventionsInputType = z.infer<typeof CheckConventionsInput>;

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
 * Queries conventions whose entry_files paths are a prefix of `filePath`.
 *
 * Uses LIKE with a trailing `%` on the stored path so that a stored path of
 * `src/api` matches a file at `src/api/users.ts`.
 *
 * @param db - Open database connection.
 * @param filePath - The full file path to match against.
 * @returns Array of matching convention rows ordered by descending confidence.
 */
function fetchByFilePath(db: Database, filePath: string): ConventionRow[] {
  return db
    .query<ConventionRow, [string]>(
      `SELECT DISTINCT e.id, e.title, e.content, e.confidence
       FROM   entries e
       JOIN   entry_files ef ON ef.entry_id = e.id
       WHERE  e.type   = 'convention'
         AND  e.status = 'active'
         AND  ? LIKE ef.file_path || '%'
       ORDER  BY e.confidence DESC
       LIMIT  10`,
    )
    .all(filePath);
}

/**
 * Queries conventions tagged with the directory portion of `filePath`.
 *
 * Extracts everything up to (and including) the last `/` as the directory,
 * then looks for conventions tagged with that directory string.
 *
 * @param db - Open database connection.
 * @param filePath - The full file path; its directory is used as the tag.
 * @returns Array of matching convention rows ordered by descending confidence.
 */
function fetchByDirectoryTag(db: Database, filePath: string): ConventionRow[] {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) {
    return [];
  }
  const directory = filePath.slice(0, lastSlash);

  return db
    .query<ConventionRow, [string]>(
      `SELECT DISTINCT e.id, e.title, e.content, e.confidence
       FROM   entries e
       JOIN   entry_tags et ON et.entry_id = e.id
       WHERE  e.type   = 'convention'
         AND  e.status = 'active'
         AND  et.tag = ?
       ORDER  BY e.confidence DESC
       LIMIT  10`,
    )
    .all(directory);
}

/**
 * Merges two convention result sets, deduplicates by id, and sorts by
 * descending confidence.
 *
 * @param a - First result set.
 * @param b - Second result set.
 * @returns Deduplicated array sorted by confidence desc.
 */
function mergeAndDeduplicate(a: ConventionRow[], b: ConventionRow[]): ConventionRow[] {
  const seen = new Map<string, ConventionRow>();
  for (const row of [...a, ...b]) {
    if (!seen.has(row.id)) {
      seen.set(row.id, row);
    }
  }
  return Array.from(seen.values()).sort((x, y) => y.confidence - x.confidence);
}

/**
 * Formats convention rows into a human-readable markdown string.
 *
 * @param rows - Convention rows to format.
 * @param filePath - The queried file path, used in the header.
 * @returns Formatted markdown string.
 */
function formatResults(rows: ConventionRow[], filePath: string): string {
  if (rows.length === 0) {
    return "No conventions recorded for this path yet.";
  }

  const header = `Conventions for ${filePath}:\n`;
  const sections = rows.map((row) =>
    [
      `## ${row.title} (confidence: ${row.confidence.toFixed(2)})`,
      row.content,
      "---",
    ].join("\n"),
  );

  return header + "\n" + sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `check_conventions` tool on the given MCP server.
 *
 * Returns team coding conventions that apply to a specific file or directory.
 * Useful for agents to check standards before writing code in a new area.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerCheckConventionsTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "check_conventions",
    "Check which team coding conventions apply to a specific file or directory. Use before writing code in a new area.",
    CheckConventionsInput.shape,
    async (input: CheckConventionsInputType) => {
      logger.info("check_conventions tool called", { file_path: input.file_path });

      const byFilePath = fetchByFilePath(db, input.file_path);
      const byDirTag = fetchByDirectoryTag(db, input.file_path);
      const rows = mergeAndDeduplicate(byFilePath, byDirTag);

      logger.info("check_conventions results", {
        file_path: input.file_path,
        byFilePath: byFilePath.length,
        byDirTag: byDirTag.length,
        merged: rows.length,
      });

      // Log activity when running in team mode with a known developer
      if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "check_conventions");
      }

      const formatted = formatResults(rows, input.file_path);

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    },
  );
}
