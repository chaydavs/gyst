/**
 * Gyst HTTP server — wraps the MCP server for team (Mode 2) use.
 *
 * Uses Bun.serve() with the WebStandardStreamableHTTPServerTransport so that
 * AI clients can connect over HTTP instead of stdio.
 *
 * Routes:
 *   GET  /health  — health check (no auth required)
 *   POST /mcp     — MCP Streamable HTTP endpoint (Bearer auth required)
 *   GET  /mcp     — SSE stream for server-initiated messages (Bearer auth required)
 *   *             — 404
 *
 * Auth:
 *   Every /mcp request must carry `Authorization: Bearer gyst_<prefix>_<...>`.
 *   The auth context (teamId, developerId) is passed to tool handlers so that
 *   activity can be logged per-developer.
 *
 * Session strategy:
 *   Stateless — each request gets its own transport instance.  This keeps the
 *   server horizontally scalable and avoids in-memory session state.  Clients
 *   that need to resume long-running operations should reconnect.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { initDatabase } from "../store/database.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { AuthError, authenticateRequest, initTeamSchema } from "./auth.js";
import { initActivitySchema } from "./activity.js";
import { registerHttpLearnTool } from "./tools/learnHttp.js";
import { registerHttpRecallTool } from "./tools/recallHttp.js";
import { registerHttpConventionsTool } from "./tools/conventionsHttp.js";
import { registerHttpFailuresTool } from "./tools/failuresHttp.js";
import type { Database } from "bun:sqlite";
import type { AuthContext } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for startHttpServer. */
export interface HttpServerOptions {
  /** TCP port to listen on. */
  readonly port: number;
  /** Path to the SQLite database file. */
  readonly dbPath: string;
}

// ---------------------------------------------------------------------------
// Health check response
// ---------------------------------------------------------------------------

const HEALTH_RESPONSE = new Response(
  JSON.stringify({ status: "ok", service: "gyst", version: "0.1.0" }),
  {
    status: 200,
    headers: { "Content-Type": "application/json" },
  },
);

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

function unauthorizedResponse(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="gyst"',
      },
    },
  );
}

function notFoundResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Not found" }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

function internalErrorResponse(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Per-request MCP server factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh McpServer with all tools registered for a specific auth
 * context.  Tools receive `authCtx` in their closure so they can log activity
 * and (in future) scope queries to the caller's team.
 *
 * @param db      - Open database connection (shared across requests).
 * @param authCtx - Resolved auth context for this request.
 */
function createMcpServer(db: Database, authCtx: AuthContext): McpServer {
  const server = new McpServer({ name: "gyst", version: "0.1.0" });

  registerHttpLearnTool(server, db, authCtx);
  registerHttpRecallTool(server, db, authCtx);
  registerHttpConventionsTool(server, db, authCtx);
  registerHttpFailuresTool(server, db, authCtx);

  return server;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/**
 * Handles a single /mcp request end-to-end:
 *  1. Authenticate via Bearer token.
 *  2. Create a stateless transport + scoped MCP server.
 *  3. Connect and delegate to the transport.
 *
 * @param req - Incoming Web Standard Request.
 * @param db  - Shared database connection.
 */
async function handleMcpRequest(req: Request, db: Database): Promise<Response> {
  // 1. Authenticate
  let authCtx: AuthContext;
  try {
    authCtx = await authenticateRequest(req, db);
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn("Authentication failed", { message: err.message });
      return unauthorizedResponse(err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Unexpected auth error", { error: msg });
    return internalErrorResponse("Authentication error");
  }

  // 2. Build scoped MCP server + stateless transport
  const mcpServer = createMcpServer(db, authCtx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no sessionIdGenerator
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });

  // 3. Connect and handle
  try {
    await mcpServer.connect(transport);
    const response = await transport.handleRequest(req);
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("MCP request handling failed", {
      teamId: authCtx.teamId,
      developerId: authCtx.developerId,
      error: msg,
    });
    return internalErrorResponse("Internal server error");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the Gyst HTTP server on the given port.
 *
 * Initialises the database (applying the core schema plus team/activity
 * extensions), then opens a Bun HTTP server that routes requests to the
 * appropriate handler.
 *
 * @param options - Port and database path.
 */
export function startHttpServer(options: HttpServerOptions): void {
  const { port, dbPath } = options;

  // Load config for wikiDir etc.
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  // Open database and apply all schema extensions
  const db = initDatabase(dbPath);
  initTeamSchema(db);
  initActivitySchema(db);

  // Start Bun HTTP server
  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();

      logger.debug("HTTP request", { method, path: url.pathname });

      // Health check — no auth required
      if (url.pathname === "/health" && method === "GET") {
        return HEALTH_RESPONSE;
      }

      // MCP endpoint
      if (url.pathname === "/mcp" && (method === "POST" || method === "GET")) {
        return handleMcpRequest(req, db);
      }

      return notFoundResponse();
    },
  });

  logger.info("Gyst HTTP server started", {
    port: server.port,
    dbPath,
  });

  // Log startup to stdout so the user can see the address
  process.stdout.write(
    `Gyst HTTP server listening on http://localhost:${server.port}\n`,
  );
  process.stdout.write(`  MCP endpoint : POST http://localhost:${server.port}/mcp\n`);
  process.stdout.write(`  Health check : GET  http://localhost:${server.port}/health\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point (bun run src/server/http.ts)
// ---------------------------------------------------------------------------

// Only run when executed directly (not imported as a module)
if (import.meta.main) {
  const portStr = process.env["GYST_PORT"] ?? "3000";
  const port = parseInt(portStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    process.stderr.write(`Invalid GYST_PORT: ${portStr}\n`);
    process.exit(1);
  }

  const config = loadConfig();

  startHttpServer({ port, dbPath: config.dbPath });
}
