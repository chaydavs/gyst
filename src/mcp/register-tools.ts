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
import { emitEvent, type EventType } from "../store/events.js";
import { loadConfig } from "../utils/config.js";
import { registerLearnTool } from "./tools/learn.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerStatusTool } from "./tools/status.js";
import { registerFeedbackTool } from "./tools/feedback.js";
import { registerHarvestTool } from "./tools/harvest.js";
import { registerCheckTool } from "./tools/check.js";
import { registerGraphTool } from "./tools/graph.js";
import { registerConfigureTool } from "./tools/configure.js";
// Note: conventions, failures, activity, check-conventions, search, get-entry are
// internal helpers used via inlined logic in recall.ts and check.ts. They are
// NOT imported here to avoid unused-import lint errors.

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
 * Registers MCP tools on the given server.
 *
 * Primary tools (always registered — 3 total):
 *   - learn   — record team knowledge
 *   - recall  — search knowledge (absorbs search/get_entry/conventions/failures via mode param)
 *   - check   — check file against conventions (absorbs check_conventions via mode param)
 *
 * Extended tools (registered only when `exposeExtendedTools: true` in config — 5 total):
 *   - graph, feedback, harvest, status (absorbs activity), configure
 *
 * Legacy tools (search, get_entry, conventions, failures, activity, check_conventions)
 * remain as internal helpers — their registration functions are NOT called by default.
 * Enable them by setting `exposeExtendedTools: true` in `.gyst-wiki.json`, or use the
 * `gyst configure --extended-tools` CLI flag.
 *
 * This is the single call site used by both transports — stdio passes
 * `{ mode: "personal", db }` and HTTP passes `{ mode: "team", db, teamId, developerId }`.
 *
 * @param server - McpServer instance to register tools on.
 * @param ctx    - Context object with database and optional team identifiers.
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  instrumentServer(server, ctx.db);

  // --- Primary tools (always visible, 3 total) ---
  registerLearnTool(server, ctx);
  registerRecallTool(server, ctx);   // absorbs search / get_entry / conventions / failures
  registerCheckTool(server, ctx);    // absorbs check_conventions

  // --- Extended tools (gated behind exposeExtendedTools config flag) ---
  const config = loadConfig();
  if (config.exposeExtendedTools) {
    registerGraphTool(server, ctx);
    registerFeedbackTool(server, ctx);
    registerHarvestTool(server, ctx);
    registerStatusTool(server, ctx);     // absorbs activity
    registerConfigureTool(server, ctx);
  }

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

/**
 * Instruments the McpServer by wrapping its `tool` method.
 *
 * Every tool registered AFTER this call will have its handler wrapped to
 * emit a `tool_use` event to the database upon completion.
 */
const DIM   = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN  = "\x1b[36m";
const RST   = "\x1b[0m";

function mcpBadge(toolName: string): void {
  const label = toolName.slice(0, 26).padEnd(26);
  process.stderr.write(
    `${DIM}┌─ ${GREEN}gyst${RST}${DIM} ──────────────────────┐${RST}\n` +
    `${DIM}│${RST} ${CYAN}◆${RST} ${label} ${DIM}│${RST}\n` +
    `${DIM}└─────────────────────────────┘${RST}\n`,
  );
}

export function instrumentServer(server: McpServer, db: Database): void {
  const original = server.tool.bind(server) as typeof server.tool;

  server.tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const last = args[args.length - 1];

    if (typeof last === "function") {
      const cb = last as (...cbArgs: unknown[]) => Promise<unknown> | unknown;
      const wrapped = async (...cbArgs: unknown[]) => {
        mcpBadge(name);
        try {
          return await cb(...cbArgs);
        } finally {
          try {
            emitEvent(db, "tool_use" as EventType, {
              tool: name,
              args: cbArgs[0] ?? {},
              ts: Date.now(),
            });
          } catch {
            // fire-and-forget
          }
        }
      };
      args[args.length - 1] = wrapped;
    }

    // @ts-expect-error — pass-through
    return original(...args);
  };
}
