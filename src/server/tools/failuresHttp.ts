/**
 * HTTP-aware wrapper for the `failures` MCP tool.
 *
 * Delegates to the same error-pattern lookup logic as the stdio version and
 * appends an activity log entry for the calling developer.
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
import { logActivity } from "../activity.js";
import type { AuthContext } from "../auth.js";

// ---------------------------------------------------------------------------
// Input schema (identical to the stdio version)
// ---------------------------------------------------------------------------

const FailuresInput = z.object({
  error_message: z.string().min(5),
  error_type: z.string().optional(),
  file: z.string().optional(),
});

type FailuresInputType = z.infer<typeof FailuresInput>;

// ---------------------------------------------------------------------------
// Internal row type
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

function fetchFailuresByIds(db: Database, ids: readonly string[]): FailureRow[] {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .query<FailureRow, string[]>(
      `SELECT id, title, content, confidence, error_signature
       FROM   entries
       WHERE  id IN (${placeholders})
         AND  type   = 'error_pattern'
         AND  status = 'active'
       ORDER  BY confidence DESC`,
    )
    .all(...ids);
}

function formatFailures(rows: readonly FailureRow[], maxTokens: number): string {
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
  return truncateToTokenBudget(header + sections.join("\n\n"), maxTokens);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `failures` tool on an HTTP-scoped MCP server.
 *
 * Normalises the error, searches for exact fingerprint matches first, then
 * falls back to BM25. Logs the query as activity for the calling developer.
 *
 * @param server  - The McpServer instance to register on.
 * @param db      - Open bun:sqlite Database.
 * @param authCtx - Resolved auth context for the current HTTP session.
 */
export function registerHttpFailuresTool(
  server: McpServer,
  db: Database,
  authCtx: AuthContext,
): void {
  server.tool(
    "failures",
    "Check if an error has been seen before and retrieve known fixes.",
    FailuresInput.shape,
    async (input: FailuresInputType) => {
      logger.info("failures tool called (http)", {
        error_type: input.error_type,
        file: input.file,
        developerId: authCtx.developerId,
      });

      const config = loadConfig();

      const normalised = normalizeErrorSignature(input.error_message);
      // generateFingerprint is used for deduplication in the learn tool;
      // the failures tool uses it only for logging context (not stored here)
      void (input.error_type !== undefined
        ? generateFingerprint(input.error_type, normalised)
        : undefined);

      let rows = searchBySignature(db, normalised);

      if (rows.length === 0) {
        const bm25Results = searchByBM25(db, normalised, "error_pattern");
        const ids = bm25Results.slice(0, 5).map((r) => r.id);
        rows = fetchFailuresByIds(db, ids);
      }

      const filtered = rows.filter(
        (r) => r.confidence >= config.confidenceThreshold,
      );

      logger.info("failures results (http)", {
        total: rows.length,
        afterFilter: filtered.length,
        developerId: authCtx.developerId,
      });

      // Log activity
      if (authCtx.developerId !== null) {
        const fileList = input.file !== undefined ? [input.file] : undefined;
        logActivity(db, authCtx.teamId, authCtx.developerId, "failures", undefined, fileList);
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
