/**
 * The `check` MCP tool — check a file against active team conventions.
 *
 * Accepts a file path and optional pre-loaded content, runs the violation
 * engine, and returns a human-readable report of rule violations with line
 * numbers and suggestions.
 *
 * Use before committing code that touches areas with detected conventions.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkFileViolations } from "../../compiler/check-violations.js";
import { logger } from "../../utils/logger.js";
import { ValidationError } from "../../utils/errors.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const CheckInput = z.object({
  /**
   * Operating mode:
   *   - 'all' (default): run all violation detectors (current behavior)
   *   - 'conventions': only check which conventions apply to this file path
   */
  mode: z.enum(["all", "conventions"]).optional().default("all"),
  file_path:    z.string().min(1).max(500),
  content:      z.string().max(200_000).optional(),
  developer_id: z.string().optional(),
});

type CheckInputType = z.infer<typeof CheckInput>;

// ---------------------------------------------------------------------------
// Severity icons
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<"error" | "warning" | "info", string> = {
  error:   "❌",
  warning: "⚠️",
  info:    "ℹ️",
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `check` tool on the given MCP server.
 *
 * The tool fetches all active conventions that apply to the supplied file
 * path, runs the violation engine, and returns a formatted report.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx    - Tool context containing db, mode, and optional team identifiers.
 */
export function registerCheckTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;

  server.tool(
    "check",
    "Check code against team conventions. mode='all' (default): run all violation detectors, returns violations with line numbers. mode='conventions': list which conventions apply to this file path. Use before committing new code.",
    CheckInput.shape,
    async (input: CheckInputType) => {
      logger.info("check tool called", { file_path: input.file_path, mode: input.mode });

      const parseResult = CheckInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid check input: ${msg}`);
      }

      const { file_path, content, mode } = parseResult.data;

      // --- mode='conventions': show which conventions apply to this file ---
      if (mode === "conventions") {
        interface ConventionRow { id: string; title: string; content: string; confidence: number; }

        // By file path prefix
        const byPath = db.query<ConventionRow, [string]>(
          `SELECT DISTINCT e.id, e.title, e.content, e.confidence
           FROM   entries e
           JOIN   entry_files ef ON ef.entry_id = e.id
           WHERE  e.type = 'convention' AND e.status = 'active'
             AND  ? LIKE ef.file_path || '%'
           ORDER  BY e.confidence DESC LIMIT 10`,
        ).all(file_path);

        // By directory tag fallback
        const lastSlash = file_path.lastIndexOf("/");
        const byTag: ConventionRow[] = lastSlash !== -1
          ? db.query<ConventionRow, [string]>(
              `SELECT DISTINCT e.id, e.title, e.content, e.confidence
               FROM   entries e
               JOIN   entry_tags et ON et.entry_id = e.id
               WHERE  e.type = 'convention' AND e.status = 'active'
                 AND  et.tag = ?
               ORDER  BY e.confidence DESC LIMIT 10`,
            ).all(file_path.slice(0, lastSlash))
          : [];

        // Merge and deduplicate
        const seen = new Set<string>();
        const merged: ConventionRow[] = [];
        for (const row of [...byPath, ...byTag]) {
          if (!seen.has(row.id)) { seen.add(row.id); merged.push(row); }
        }
        merged.sort((a, b) => b.confidence - a.confidence);

        if (merged.length === 0) {
          return { content: [{ type: "text" as const, text: `No conventions found for ${file_path}.` }] };
        }

        const lines = [`Conventions applying to ${file_path}:\n`];
        for (const row of merged) {
          lines.push(`## ${row.title} (confidence: ${row.confidence.toFixed(2)})`);
          lines.push(row.content);
          lines.push("---");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      // --- mode='all' (default): run full violation engine ---
      const violations = checkFileViolations(db, file_path, content);

      // Build formatted report.
      let report = `Checking ${file_path} against conventions...\n\n`;

      if (violations.length === 0) {
        report += "No violations found.";
      } else {
        for (const v of violations) {
          const icon = SEVERITY_ICON[v.severity];
          const lineLabel = v.line > 0 ? `Line ${v.line} ` : "";
          report += `${icon} ${lineLabel}[${v.severity}] ${v.rule}\n`;
          report += `   ${v.message}\n`;
          if (v.suggestion !== undefined) {
            report += `   Suggestion: ${v.suggestion}\n`;
          }
          report += "\n";
        }
        report += `${violations.length} violation(s) found.`;
      }

      // Log activity in team mode.
      if (
        ctx.mode === "team" &&
        ctx.developerId !== undefined &&
        ctx.teamId !== undefined
      ) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "check", undefined, [
          file_path,
        ]);
      }

      return { content: [{ type: "text" as const, text: report }] };
    },
  );
}
