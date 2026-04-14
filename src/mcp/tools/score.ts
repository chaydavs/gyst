/**
 * The `score` MCP tool — return the team knowledge uniformity score.
 *
 * Exposes `computeUniformityScore` from the store layer as an MCP tool,
 * returning a human-readable breakdown of the 0–100 score with four
 * labelled subscores and their supporting statistics.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeUniformityScore } from "../../store/uniformity.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const ScoreInput = z.object({
  /** Optional developer ID — reserved for future per-developer scoping. */
  developer_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `score` tool on the given MCP server.
 *
 * Returns the team knowledge uniformity score (0–100) with four subscores:
 * coverage, ghost rules, freshness, and style. Agents should use this to
 * assess how comprehensively team conventions, rules, and decisions are
 * documented across the codebase.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx    - Tool context containing db, mode, and optional team identifiers.
 */
export function registerScoreTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;

  server.tool(
    "score",
    "Check how comprehensively team conventions and rules are documented (0–100 score with subscores for coverage, ghost rules, freshness, and style). Use to identify knowledge gaps.",
    ScoreInput.shape,
    async (_input) => {
      logger.info("score tool called");

      const report = computeUniformityScore(db);

      const lines = [
        `Uniformity score: ${report.score}/100`,
        `  Coverage:    ${report.subscores.coverage.toFixed(2)}   (${report.details.directoriesCovered} of ${report.details.directoriesTotal} directories)`,
        `  Ghost rules: ${report.subscores.ghost.toFixed(2)}   (${report.details.ghostCount} active rules)`,
        `  Freshness:   ${report.subscores.freshness.toFixed(2)}   (avg ${Math.round(report.details.avgFreshnessDays)} days since confirmation)`,
        `  Style:       ${report.subscores.style.toFixed(2)}   (${Math.round(report.details.highConfidenceRatio * 100)}% of conventions high-confidence)`,
      ];

      if (
        ctx.mode === "team" &&
        ctx.developerId !== undefined &&
        ctx.teamId !== undefined
      ) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(
          ctx.db,
          ctx.teamId,
          ctx.developerId,
          "score",
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
