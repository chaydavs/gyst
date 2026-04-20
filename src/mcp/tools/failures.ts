/**
 * The `failures` MCP tool — DEPRECATED.
 *
 * Prefer `check({ action: "failures", error_message })`. This file now
 * delegates to the unified `check` tool's failures handler and prepends a
 * deprecation notice to the response.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";
import { handleCheckFailures } from "./check.js";

const FailuresInput = z.object({
  error_message: z.string().min(5),
  error_type: z.string().optional(),
  file: z.string().optional(),
});

type FailuresInputType = z.infer<typeof FailuresInput>;

export function registerFailuresTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "failures",
    "[DEPRECATED — use `check` with action: \"failures\"] Check if an error has been seen before and get the known fix. Still functional; will be removed in a future release.",
    FailuresInput.shape,
    async (input: FailuresInputType) => {
      logger.warn('failures tool is deprecated, use `check` with action: "failures"');
      const result = await handleCheckFailures(ctx, {
        error_message: input.error_message,
        error_type: input.error_type,
        file: input.file,
      });
      const prefix =
        '⚠️ `failures` is deprecated — use `check({ action: "failures", error_message })`. Forwarding for now.\n\n';
      return {
        content: [
          { type: "text" as const, text: prefix + (result.content[0]?.text ?? "") },
        ],
      };
    },
  );
}
