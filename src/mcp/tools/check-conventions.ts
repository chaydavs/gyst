/**
 * The `check_conventions` MCP tool — DEPRECATED.
 *
 * Prefer `check({ action: "conventions", file_path })`. This file now delegates
 * to the unified `check` tool's conventions handler and prepends a deprecation
 * notice to the response.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";
import { handleCheckConventions } from "./check.js";

const CheckConventionsInput = z.object({
  file_path: z.string().min(1).max(1000),
});

type CheckConventionsInputType = z.infer<typeof CheckConventionsInput>;

export function registerCheckConventionsTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "check_conventions",
    "[DEPRECATED — use `check` with action: \"conventions\"] List which team conventions apply to a file or directory. Still functional; will be removed in a future release.",
    CheckConventionsInput.shape,
    async (input: CheckConventionsInputType) => {
      logger.warn(
        'check_conventions tool is deprecated, use `check` with action: "conventions"',
      );
      const result = await handleCheckConventions(ctx, { file_path: input.file_path });
      const prefix =
        '⚠️ `check_conventions` is deprecated — use `check({ action: "conventions", file_path })`. Forwarding for now.\n\n';
      return {
        content: [
          { type: "text" as const, text: prefix + (result.content[0]?.text ?? "") },
        ],
      };
    },
  );
}
