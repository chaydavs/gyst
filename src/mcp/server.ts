/**
 * Gyst MCP server entry point.
 *
 * Initialises the SQLite database, registers all tools, and connects via the
 * stdio transport so that AI coding agents can communicate with the server
 * over stdin/stdout.
 *
 * All logging goes to stderr to avoid polluting the MCP stdio channel.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { canLoadExtensions, initDatabase } from "../store/database.js";
import { backfillVectors, initVectorStore } from "../store/embeddings.js";
import { rebuildFromMarkdown } from "../store/rebuild.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { registerAllTools } from "./register-tools.js";
import { startEventProcessor } from "./events.js";

/**
 * Recursively finds the maximum mtimeMs across all .md files under `dir`.
 * Returns 0 if the directory doesn't exist or contains no markdown files.
 */
function getNewestFileMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, getNewestFileMtime(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      newest = Math.max(newest, statSync(fullPath).mtimeMs);
    }
  }
  return newest;
}

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
const globalDb = initDatabase(config.globalDbPath);

// Start background event processor
startEventProcessor(db);

// Initialise semantic search (Strategy 5). Graceful if unavailable —
// the rest of the server keeps running with BM25 + graph + temporal.
if (canLoadExtensions()) {
  initVectorStore(db);
  initVectorStore(globalDb);

  // Backfill in background
  backfillVectors(db).catch(() => {});
  backfillVectors(globalDb).catch(() => {});
}

  // Auto-rebuild: if any wiki markdown file is newer than the database,
  // the index is stale (e.g. after a git pull that brought in new entries).
  const wikiMtime = getNewestFileMtime(config.wikiDir);
  const dbMtime = existsSync(config.dbPath) ? statSync(config.dbPath).mtimeMs : 0;
  if (wikiMtime > dbMtime) {
    logger.info("Wiki files newer than database, auto-rebuilding", {
      wikiMtime: new Date(wikiMtime).toISOString(),
      dbMtime: dbMtime > 0 ? new Date(dbMtime).toISOString() : "none",
    });
    try {
      const stats = await rebuildFromMarkdown(config);
      logger.info("Auto-rebuild complete", stats as unknown as Record<string, unknown>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Auto-rebuild failed — continuing with existing index", { error: msg });
    }
  }

  // Register tools
  registerAllTools(server, { mode: "personal", db, globalDb });

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
