/**
 * The unified `read` MCP tool.
 *
 * Merges three previously separate tools behind a single entry point:
 *   - action: "recall"    — full-content ranked search (default)
 *   - action: "search"    — compact index of matches, 7× fewer tokens
 *   - action: "get_entry" — full markdown for a single entry by id
 *
 * The legacy `recall`, `search`, and `get_entry` tools remain registered with
 * deprecation prefixes for backward compatibility.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../register-tools.js";
import { ValidationError } from "../../utils/errors.js";
import { handleRecall, RecallInput } from "./recall.js";
import { handleSearch, SearchInput } from "./search.js";
import { handleGetEntry, GetEntryInput } from "./get-entry.js";

// ---------------------------------------------------------------------------
// Input schema — a superset of the three legacy inputs gated by `action`.
// Each action validates its own required fields inside the dispatcher.
// ---------------------------------------------------------------------------

const ReadInput = z.object({
  action: z
    .enum(["recall", "search", "get_entry"])
    .optional()
    .default("recall")
    .describe(
      'What to do: "recall" (ranked full-content, default), "search" (compact index), "get_entry" (by id).',
    ),
  // recall + search shared
  query: z.string().min(2).max(500).optional(),
  type: z
    .enum(["error_pattern", "convention", "decision", "learning", "ghost_knowledge", "all"])
    .optional()
    .default("all"),
  scope: z.enum(["personal", "team", "project"]).optional(),
  developer_id: z.string().optional(),
  // recall-specific
  files: z.array(z.string()).optional().default([]),
  max_results: z.number().min(1).max(10).optional().default(5),
  context_budget: z.number().int().min(200).max(20000).optional(),
  // search-specific
  limit: z.number().int().min(1).max(50).optional().default(10),
  // get_entry-specific
  id: z.string().min(1).optional(),
});

type ReadInputType = z.infer<typeof ReadInput>;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatchRead(
  ctx: ToolContext,
  input: ReadInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (input.action) {
    case "search": {
      if (!input.query) {
        throw new ValidationError('read action "search" requires query.');
      }
      const parsed = SearchInput.parse({
        query: input.query,
        type: input.type,
        limit: input.limit,
        scope: input.scope,
        developer_id: input.developer_id,
      });
      return handleSearch(ctx, parsed);
    }
    case "get_entry": {
      if (!input.id) {
        throw new ValidationError('read action "get_entry" requires id.');
      }
      const parsed = GetEntryInput.parse({
        id: input.id,
        developer_id: input.developer_id,
      });
      return handleGetEntry(ctx, parsed);
    }
    case "recall":
    default: {
      if (!input.query) {
        throw new ValidationError('read action "recall" requires query.');
      }
      const parsed = RecallInput.parse({
        query: input.query,
        type: input.type,
        files: input.files,
        max_results: input.max_results,
        scope: input.scope,
        developer_id: input.developer_id,
        context_budget: input.context_budget,
      });
      return handleRecall(ctx, parsed);
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the unified `read` tool on the given MCP server.
 *
 * Use it as the single entry point for reading team knowledge:
 *   read({ action: "recall",    query })              — full-content ranked search
 *   read({ action: "search",    query })              — compact index, cheap tokens
 *   read({ action: "get_entry", id })                 — full detail for one entry
 */
export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "read",
    'Read team knowledge. action="recall" (default) returns ranked full-content results; action="search" returns a compact index (7× fewer tokens, follow up with get_entry); action="get_entry" fetches one entry by id.',
    ReadInput.shape,
    async (input: ReadInputType) => {
      const parseResult = ReadInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid read input: ${msg}`);
      }
      return dispatchRead(ctx, parseResult.data);
    },
  );
}
