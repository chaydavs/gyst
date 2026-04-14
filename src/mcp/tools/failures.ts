/**
 * The `failures` MCP tool — check if an error has been seen before.
 *
 * Normalises the incoming error message, generates a fingerprint, and searches
 * the knowledge base for matching error patterns. Returns any known fixes or
 * resolutions.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import {
  normalizeErrorSignature,
  generateFingerprint,
} from "../../compiler/normalize.js";
import { searchByBM25 } from "../../store/search.js";
import { loadConfig } from "../../utils/config.js";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const FailuresInput = z.object({
  error_message: z.string().min(5),
  error_type: z.string().optional(),
  file: z.string().optional(),
});

type FailuresInputType = z.infer<typeof FailuresInput>;

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface FailureRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
  error_signature: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Searches for error pattern entries by exact error_signature match.
 *
 * @param db - Open database connection.
 * @param signature - Normalised error signature to look up.
 * @returns Array of matching rows ordered by descending confidence.
 */
function searchBySignature(db: Database, signature: string): FailureRow[] {
  return db
    .query<FailureRow, [string]>(
      `SELECT id, title, content, confidence, error_signature
       FROM   entries
       WHERE  error_signature = ?
         AND  type   = 'error_pattern'
         AND  status = 'active'
       ORDER  BY confidence DESC`,
    )
    .all(signature);
}

/**
 * Fetches full entry data for a list of ids (error_pattern only).
 *
 * @param db - Open database connection.
 * @param ids - Entry ids to hydrate.
 * @returns Array of failure rows in the provided id order.
 */
function fetchFailuresByIds(db: Database, ids: string[]): FailureRow[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query<FailureRow, string[]>(
      `SELECT id, title, content, confidence, error_signature
       FROM   entries
       WHERE  id IN (${placeholders})
         AND  type   = 'error_pattern'
         AND  status = 'active'
       ORDER  BY confidence DESC`,
    )
    .all(...ids);

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });
}

/**
 * Formats failure entries as a markdown string within the token budget.
 *
 * @param rows - Failure rows to format.
 * @param maxTokens - Maximum token budget.
 * @returns Formatted markdown string.
 */
function formatFailures(rows: FailureRow[], maxTokens: number): string {
  if (rows.length === 0) {
    return "No known error patterns found matching this error.";
  }

  const header = `Found ${rows.length} known error pattern(s):\n\n`;

  const sections = rows.map((row) =>
    [
      `## ${row.title} (confidence: ${row.confidence.toFixed(2)})`,
      row.content,
      "---",
    ].join("\n"),
  );

  const body = header + sections.join("\n\n");
  return truncateToTokenBudget(body, maxTokens);
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `failures` tool on the given MCP server.
 *
 * Normalises the error, searches for exact fingerprint matches first, then
 * falls back to BM25 search against the normalised signature. Returns known
 * fixes and resolutions.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerFailuresTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "failures",
    "Check if an error has been seen before and retrieve known fixes. Call this immediately when encountering an unfamiliar error.",
    FailuresInput.shape,
    async (input: FailuresInputType) => {
      logger.info("failures tool called", {
        error_type: input.error_type,
        file: input.file,
      });

      const config = loadConfig();

      // 1. Normalise the error message
      const normalised = normalizeErrorSignature(input.error_message);

      // 2. Generate fingerprint when error type is provided
      const fingerprint =
        input.error_type !== undefined
          ? generateFingerprint(input.error_type, normalised)
          : undefined;

      logger.debug("failures normalised", { normalised, fingerprint });

      // 3. Exact match by normalised signature
      let rows = searchBySignature(db, normalised);

      // 4. Fallback to BM25 over FTS5 index using the normalised signature
      if (rows.length === 0) {
        const bm25Results = searchByBM25(db, normalised, "error_pattern");
        const ids = bm25Results.slice(0, 5).map((r) => r.id);
        rows = fetchFailuresByIds(db, ids);
      }

      // Apply confidence threshold
      const filtered = rows.filter(
        (r) => r.confidence >= config.confidenceThreshold,
      );

      logger.info("failures results", {
        total: rows.length,
        afterFilter: filtered.length,
      });

      // Log activity when running in team mode with a known developer
      if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
        const { logActivity } = await import("../../server/activity.js");
        const fileList = input.file !== undefined ? [input.file] : undefined;
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "failures", undefined, fileList);
      }

      const formatted = formatFailures(filtered, config.maxRecallTokens);

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
