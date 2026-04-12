/**
 * Gyst MCP server entry point.
 *
 * Initialises the SQLite database, registers all tools, and connects via the
 * stdio transport so that AI coding agents can communicate with the server
 * over stdin/stdout.
 *
 * All logging goes to stderr to avoid polluting the MCP stdio channel.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { canLoadExtensions, initDatabase } from "../store/database.js";
import { backfillVectors, initVectorStore } from "../store/embeddings.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { registerLearnTool } from "./tools/learn.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerConventionsTool } from "./tools/conventions.js";
import { registerFailuresTool } from "./tools/failures.js";
import { registerActivityTool } from "./tools/activity.js";
import { registerStatusTool } from "./tools/status.js";
import { registerFeedbackTool } from "./tools/feedback.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Starts the Gyst MCP server.
 *
 * Order of operations:
 * 1. Load project configuration (`.gyst-wiki.json` or defaults).
 * 2. Initialise the SQLite database and apply the schema.
 * 3. Register all four MCP tools.
 * 4. Connect to the stdio transport and begin serving requests.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  const server = new McpServer({
    name: "gyst",
    version: "0.1.0",
  });

  // Initialise database (synchronous — bun:sqlite)
  const db = initDatabase(config.dbPath);

  // Initialise semantic search (Strategy 5). Graceful if unavailable —
  // the rest of the server keeps running with BM25 + graph + temporal.
  if (canLoadExtensions()) {
    const ok = initVectorStore(db);
    if (ok) {
      // Backfill any entries that predate the vector store in the background.
      // Fire-and-forget so the server is ready for tool calls immediately.
      backfillVectors(db).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Vector backfill failed", { error: msg });
      });
    }
  }

  // Register tools
  registerLearnTool(server, db);
  registerRecallTool(server, db);
  registerConventionsTool(server, db);
  registerFailuresTool(server, db);
  registerActivityTool(server, db);
  registerStatusTool(server, db);
  registerFeedbackTool(server, db);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Gyst MCP server started", {
    dbPath: config.dbPath,
    wikiDir: config.wikiDir,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error("Server failed to start", { error: msg });
  process.exit(1);
});
