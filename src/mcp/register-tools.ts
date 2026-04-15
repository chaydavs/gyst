/**
 * Shared tool registry for the Gyst MCP server.
 *
 * Provides a single `registerAllTools` entry point used by both the stdio
 * transport (personal mode) and the HTTP transport (team mode).
 *
 * The `ToolContext` carries the database connection plus optional team/developer
 * identifiers so tool handlers can conditionally log activity, scope entries,
 * and fill in defaults without the callers duplicating that logic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { registerLearnTool } from "./tools/learn.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerConventionsTool } from "./tools/conventions.js";
import { registerFailuresTool } from "./tools/failures.js";
import { registerActivityTool } from "./tools/activity.js";
import { registerStatusTool } from "./tools/status.js";
import { registerFeedbackTool } from "./tools/feedback.js";
import { registerHarvestTool } from "./tools/harvest.js";
import { registerCheckConventionsTool } from "./tools/check-conventions.js";
import { registerSearchTool } from "./tools/search.js";
import { registerGetEntryTool } from "./tools/get-entry.js";
import { registerCheckTool } from "./tools/check.js";
import { registerScoreTool } from "./tools/score.js";
import { registerGraphTool } from "./tools/graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to every tool registration function.
 *
 * - `mode: "personal"` — single-developer stdio transport; no activity logging,
 *   no team scoping. `teamId` and `developerId` are absent.
 * - `mode: "team"` — HTTP transport with Bearer-token auth; activity is logged
 *   after each tool call and new entries default to `scope: "team"`.
 */
export interface ToolContext {
  /** Transport mode — controls activity logging and default entry scope. */
  readonly mode: "personal" | "team";
  /** Open bun:sqlite database connection. */
  readonly db: Database;
  /** Global personal database connection (optional). */
  readonly globalDb?: Database;
  /** Present in team mode only — identifies which team this session belongs to. */
  readonly teamId?: string;
  /** Present in team mode only — identifies the authenticated developer. */
  readonly developerId?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers all 14 Gyst MCP tools on the given server.
 *
 * This is the single call site used by both transports — stdio passes
 * `{ mode: "personal", db }` and HTTP passes `{ mode: "team", db, teamId, developerId }`.
 *
 * Each tool receives the full context so it can:
 *  - Use `ctx.db` for database access
 *  - Conditionally call `logActivity` when `ctx.mode === "team"`
 *  - Apply the correct default scope to new entries
 *
 * @param server - McpServer instance to register tools on.
 * @param ctx    - Context object with database and optional team identifiers.
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerLearnTool(server, ctx);
  registerRecallTool(server, ctx);
  registerConventionsTool(server, ctx);
  registerFailuresTool(server, ctx);
  registerActivityTool(server, ctx);
  registerStatusTool(server, ctx);
  registerFeedbackTool(server, ctx);
  registerHarvestTool(server, ctx);
  registerCheckConventionsTool(server, ctx);
  registerSearchTool(server, ctx);
  registerGetEntryTool(server, ctx);
  registerCheckTool(server, ctx);
  registerScoreTool(server, ctx);
  registerGraphTool(server, ctx);

  // --- Proactive Learning Prompt ---
  // Tells the agent how to behave without the user repeating instructions.
  server.prompt(
    "proactive-learning",
    "Gyst instructions for proactive knowledge capture.",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are equipped with Gyst, a team knowledge engine. 
To be effective, you must follow these behavioral rules:
1. **Always Recall First:** Before starting a task or solving an error, use the 'recall' tool to check for existing team knowledge or conventions.
2. **Proactive Learning:** Whenever you solve a non-trivial bug, identify a coding convention, or make an architectural decision, use the 'learn' tool to record it automatically.
3. **Be Specific:** When using 'learn', include the relevant file paths and tags so your teammates can find this knowledge later.
4. **Auto-Harvest:** If you forget to call 'learn', know that your session transcript will be processed at the end to extract key takeaways.`,
          },
        },
      ],
    }),
  );
}
