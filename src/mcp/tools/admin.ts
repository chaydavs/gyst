/**
 * The unified `admin` MCP tool.
 *
 * Merges `activity` and `status` behind a single entry point:
 *   - action: "activity" (default) — recent team knowledge activity
 *   - action: "status"              — who's active + what they're touching
 *
 * The legacy `activity` and `status` tools remain registered with deprecation
 * prefixes for backward compatibility.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../register-tools.js";
import { ValidationError } from "../../utils/errors.js";
import { handleActivity, ActivityInput } from "./activity.js";
import { handleStatus, StatusInput } from "./status.js";

const AdminInput = z.object({
  action: z
    .enum(["activity", "status"])
    .optional()
    .default("activity")
    .describe(
      'What to show: "activity" (recent learn/recall events, default) or "status" (who\'s active right now).',
    ),
  hours: z.number().min(1).max(168).optional(),
  files: z.array(z.string()).optional().default([]),
  types: z
    .array(z.enum(["error_pattern", "convention", "decision", "learning"]))
    .optional(),
});

type AdminInputType = z.infer<typeof AdminInput>;

async function dispatchAdmin(
  ctx: ToolContext,
  input: AdminInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (input.action) {
    case "status": {
      const parsed = StatusInput.parse({
        hours: input.hours ?? 2,
      });
      return handleStatus(ctx, parsed);
    }
    case "activity":
    default: {
      const parsed = ActivityInput.parse({
        hours: input.hours ?? 24,
        files: input.files,
        types: input.types,
      });
      return handleActivity(ctx, parsed);
    }
  }
}

/**
 * Registers the unified `admin` tool on the given MCP server.
 *
 * Use it as the single entry point for team-observability queries:
 *   admin({ action: "activity" })  — recent team knowledge events
 *   admin({ action: "status" })    — live snapshot of who's working on what
 */
export function registerAdminTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "admin",
    'Team observability. action="activity" (default) lists recent team knowledge events; action="status" shows who\'s currently active and what files they\'re touching.',
    AdminInput.shape,
    async (input: AdminInputType) => {
      const parseResult = AdminInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid admin input: ${msg}`);
      }
      return dispatchAdmin(ctx, parseResult.data);
    },
  );
}
