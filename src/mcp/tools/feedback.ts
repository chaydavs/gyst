/**
 * The `feedback` MCP tool — record whether a recalled entry was helpful.
 *
 * Feedback signals are stored in the `feedback` table and used by the
 * calibration script (`scripts/calibrate-confidence.ts`) to evaluate whether
 * confidence scores predict actual usefulness.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../../utils/logger.js";
import { ValidationError } from "../../utils/errors.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const FeedbackInput = z.object({
  entry_id: z.string().min(1),
  helpful: z.boolean(),
  note: z.string().max(500).optional(),
  developer_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `feedback` tool on the given MCP server.
 *
 * The tool records whether a recalled knowledge entry was helpful, enabling
 * calibration of the confidence scoring formula over time.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerFeedbackTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "feedback",
    "Record feedback on whether a recalled knowledge entry was helpful. This signal is used to calibrate confidence scores over time.",
    FeedbackInput.shape,
    async (input) => {
      try {
        const parsed = FeedbackInput.parse(input);

        // In team mode, use the context developerId if the input didn't supply one.
        const resolvedDeveloperId =
          parsed.developer_id ??
          (ctx.mode === "team" ? ctx.developerId : undefined);

        // Verify entry exists
        const existing = db
          .query<{ id: string }, [string]>("SELECT id FROM entries WHERE id = ?")
          .get(parsed.entry_id);

        if (existing === null) {
          return {
            content: [{
              type: "text" as const,
              text: `Entry ${parsed.entry_id} not found.`,
            }],
          };
        }

        // Insert feedback row and update entry confidence atomically
        let before: { confidence: number } | null = null;
        let after: { confidence: number } | null = null;

        db.transaction(() => {
          db.run(
            `INSERT INTO feedback (entry_id, developer_id, helpful, note, timestamp)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [
              parsed.entry_id,
              resolvedDeveloperId ?? null,
              parsed.helpful ? 1 : 0,
              parsed.note ?? null,
            ],
          );

          // Read current confidence before update for logging
          before = db.query<{ confidence: number }, [string]>(
            "SELECT confidence FROM entries WHERE id = ?"
          ).get(parsed.entry_id);

          db.run(
            "UPDATE entries SET confidence = MAX(0.0, MIN(1.0, confidence + ?)) WHERE id = ?",
            [parsed.helpful ? 0.02 : -0.05, parsed.entry_id]
          );

          after = db.query<{ confidence: number }, [string]>(
            "SELECT confidence FROM entries WHERE id = ?"
          ).get(parsed.entry_id);

          logger.info("Feedback applied", {
            entryId: parsed.entry_id,
            helpful: parsed.helpful,
            confidenceBefore: before?.confidence,
            confidenceAfter: after?.confidence,
          });
        })();

        return {
          content: [{
            type: "text" as const,
            text: `Feedback recorded for entry ${parsed.entry_id}: ${parsed.helpful ? "helpful" : "not helpful"} (confidence ${(before as { confidence: number } | null)?.confidence?.toFixed(3)} → ${(after as { confidence: number } | null)?.confidence?.toFixed(3)})`,
          }],
        };
      } catch (err) {
        if (err instanceof ValidationError) {
          return {
            content: [{ type: "text" as const, text: `Invalid feedback: ${err.message}` }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Feedback tool failed", { error: msg });
        return {
          content: [{ type: "text" as const, text: `Failed to record feedback: ${msg}` }],
        };
      }
    },
  );
}
