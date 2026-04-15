/**
 * Gyst HTTP server — wraps the MCP server for team (Mode 2) use.
 *
 * Uses Bun.serve() with the WebStandardStreamableHTTPServerTransport so that
 * AI clients can connect over HTTP instead of stdio.
 *
 * Routes:
 *   GET    /health               — health check (no auth required)
 *   POST   /mcp                  — MCP Streamable HTTP endpoint (Bearer auth required)
 *   GET    /mcp                  — SSE stream for server-initiated messages (Bearer auth required)
 *   POST   /team                 — create team (bootstrap or admin)
 *   POST   /team/invite          — generate invite key (admin only)
 *   POST   /team/join            — exchange invite key for member key
 *   GET    /team/members         — list team members (any authenticated member)
 *   DELETE /team/members/:id     — remove member + revoke all their keys (admin only)
 *   *                            — 404
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
 *
 * CORS:
 *   Origin controlled by GYST_CORS_ORIGIN env var (default: "*").
 *   OPTIONS preflight requests are handled automatically.
 *
 * Observability:
 *   Every response carries an X-Request-Id header.
 *   A structured access log entry is emitted via logger.info after each response.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { initDatabase } from "../store/database.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import {
  AuthError,
  authenticateRequest,
  createInviteKey,
  createTeam,
  initTeamSchema,
  joinTeam,
} from "./auth.js";
import { initActivitySchema } from "./activity.js";
import { getTeamMembers, removeMember } from "./team.js";
import { registerAllTools } from "../mcp/register-tools.js";
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

/** Handle returned by startHttpServer — call stop() to shut the server down. */
export interface HttpServerHandle {
  /** Stops the HTTP server and closes all connections. */
  readonly stop: () => void;
}

// ---------------------------------------------------------------------------
// CORS configuration
// ---------------------------------------------------------------------------

const CORS_ORIGIN = process.env["GYST_CORS_ORIGIN"] ?? "*";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Adds CORS and request-id headers to an existing Response, returning a new
 * Response object (immutable pattern).
 *
 * Also strips the internal `x-developer-id` header so it is never forwarded
 * to HTTP clients.  The outer fetch handler reads this header before calling
 * withMeta (or withMetaStrip) so that logAccess receives the resolved
 * developerId.
 */
function withMeta(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Request-Id", requestId);
  headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  headers.delete("x-developer-id");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Builds a JSON response with the given status, body, and standard headers.
 */
function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/** 401 Unauthorized */
function unauthorizedResponse(message: string, requestId: string): Response {
  return jsonResponse(
    { error: message },
    401,
    requestId,
    { "WWW-Authenticate": 'Bearer realm="gyst"' },
  );
}

/** 403 Forbidden */
function forbiddenResponse(message: string, requestId: string): Response {
  return jsonResponse({ error: message }, 403, requestId);
}

/** 400 Bad Request */
function badRequestResponse(message: string, requestId: string): Response {
  return jsonResponse({ error: message }, 400, requestId);
}

/** 404 Not Found */
function notFoundResponse(requestId: string): Response {
  return jsonResponse({ error: "Not found" }, 404, requestId);
}

/** 500 Internal Server Error */
function internalErrorResponse(message: string, requestId: string): Response {
  return jsonResponse({ error: message }, 500, requestId);
}

/**
 * Returns a Record containing the x-developer-id header when developerId is
 * non-null, or an empty Record otherwise.  Used to thread the resolved
 * developerId through handler responses to the outer fetch access log.
 */
function devIdHeaders(developerId: string | null): Record<string, string> {
  if (developerId === null) return {};
  return { "x-developer-id": developerId };
}

// ---------------------------------------------------------------------------
// Per-request MCP server factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh McpServer with all 8 tools registered for a specific auth
 * context.  Tools receive `authCtx` in their closure so they can log activity
 * and scope queries to the caller's team.
 *
 * @param db      - Open database connection (shared across requests).
 * @param authCtx - Resolved auth context for this request.
 */
function createMcpServer(db: Database, authCtx: AuthContext): McpServer {
  const server = new McpServer({ name: "gyst", version: "0.1.0" });

  registerAllTools(server, {
    mode: "team",
    db,
    teamId: authCtx.teamId,
    developerId: authCtx.developerId ?? undefined,
  });

  return server;
}

// ---------------------------------------------------------------------------
// Zod schemas for team management routes
// ---------------------------------------------------------------------------

const CreateTeamBody = z.object({
  name: z.string().min(1).max(200),
});

const JoinTeamBody = z.object({
  displayName: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Team management route handlers
// ---------------------------------------------------------------------------

/** Checks whether any teams exist in the database. */
function teamsExist(db: Database): boolean {
  const row = db
    .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM teams")
    .get();
  return (row?.cnt ?? 0) > 0;
}

/**
 * POST /team — create a team.
 * Unauthenticated bootstrap when no teams exist; admin auth required otherwise.
 */
async function handleCreateTeam(
  req: Request,
  db: Database,
  requestId: string,
): Promise<Response> {
  const existing = teamsExist(db);
  let resolvedDevId: string | null = null;

  if (existing) {
    let authCtx: AuthContext;
    try {
      authCtx = await authenticateRequest(req, db);
    } catch (err) {
      const msg = err instanceof AuthError ? err.message : "Unauthorized";
      return unauthorizedResponse(msg, requestId);
    }
    resolvedDevId = authCtx.developerId;
    if (authCtx.role !== "admin") {
      return forbiddenResponse("Admin role required to create additional teams", requestId);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("Request body must be valid JSON", requestId);
  }

  const parsed = CreateTeamBody.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return badRequestResponse(`Invalid request body: ${msg}`, requestId);
  }

  try {
    const { teamId, adminKey } = createTeam(db, parsed.data.name);
    logger.info("Team created via HTTP", { teamId, requestId });
    return jsonResponse({ teamId, adminKey }, 201, requestId, devIdHeaders(resolvedDevId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to create team", { error: msg, requestId });
    return jsonResponse({ error: "Failed to create team" }, 500, requestId, devIdHeaders(resolvedDevId));
  }
}

/**
 * POST /team/invite — generate an invite key.
 * Requires admin Bearer token.
 */
async function handleCreateInvite(
  req: Request,
  db: Database,
  requestId: string,
): Promise<Response> {
  let authCtx: AuthContext;
  try {
    authCtx = await authenticateRequest(req, db);
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : "Unauthorized";
    return unauthorizedResponse(msg, requestId);
  }

  if (authCtx.role !== "admin") {
    return forbiddenResponse("Admin role required to create invite keys", requestId);
  }

  try {
    const inviteKey = createInviteKey(db, authCtx.teamId);
    logger.info("Invite key created via HTTP", { teamId: authCtx.teamId, requestId });
    return jsonResponse({ inviteKey, expiresInHours: 24 }, 201, requestId, devIdHeaders(authCtx.developerId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to create invite key", { error: msg, requestId });
    return jsonResponse({ error: "Failed to create invite key" }, 500, requestId, devIdHeaders(authCtx.developerId));
  }
}

/**
 * POST /team/join — exchange an invite key for a member key.
 * The invite key IS the Bearer token.
 */
async function handleJoinTeam(
  req: Request,
  db: Database,
  requestId: string,
): Promise<Response> {
  let authCtx: AuthContext;
  try {
    authCtx = await authenticateRequest(req, db);
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : "Unauthorized";
    return unauthorizedResponse(msg, requestId);
  }

  if (authCtx.role !== "invite") {
    return forbiddenResponse("An invite key is required to join a team", requestId);
  }

  // Extract the raw invite key from the Authorization header so joinTeam
  // can run its internal bcrypt verification.
  const rawKey = req.headers.get("Authorization")?.split(" ")[1] ?? "";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("Request body must be valid JSON", requestId);
  }

  const parsed = JoinTeamBody.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return badRequestResponse(`Invalid request body: ${msg}`, requestId);
  }

  try {
    const { developerId, memberKey } = await joinTeam(db, rawKey, parsed.data.displayName);
    logger.info("Developer joined team via HTTP", { developerId, requestId });
    return jsonResponse({ developerId, memberKey }, 201, requestId, devIdHeaders(authCtx.developerId));
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, 401, requestId, {
        "WWW-Authenticate": 'Bearer realm="gyst"',
        ...devIdHeaders(authCtx.developerId),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to join team", { error: msg, requestId });
    return jsonResponse({ error: "Failed to join team" }, 500, requestId, devIdHeaders(authCtx.developerId));
  }
}

/**
 * GET /team/members — list team members.
 * Any authenticated member may call this.
 */
async function handleListMembers(
  req: Request,
  db: Database,
  requestId: string,
): Promise<Response> {
  let authCtx: AuthContext;
  try {
    authCtx = await authenticateRequest(req, db);
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : "Unauthorized";
    return unauthorizedResponse(msg, requestId);
  }

  try {
    const members = getTeamMembers(db, authCtx.teamId);
    return jsonResponse({ members }, 200, requestId, devIdHeaders(authCtx.developerId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to list members", { error: msg, requestId });
    return jsonResponse({ error: "Failed to list team members" }, 500, requestId, devIdHeaders(authCtx.developerId));
  }
}

/**
 * DELETE /team/members/:id — remove a member and revoke all their keys.
 * Requires admin role. Cannot remove yourself.
 */
async function handleRemoveMember(
  req: Request,
  db: Database,
  requestId: string,
  targetDeveloperId: string,
): Promise<Response> {
  let authCtx: AuthContext;
  try {
    authCtx = await authenticateRequest(req, db);
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : "Unauthorized";
    return unauthorizedResponse(msg, requestId);
  }

  if (authCtx.role !== "admin") {
    return forbiddenResponse("Admin role required to remove members", requestId);
  }

  if (authCtx.developerId !== null && authCtx.developerId === targetDeveloperId) {
    return badRequestResponse("Cannot remove yourself from the team", requestId);
  }

  try {
    removeMember(db, authCtx.teamId, targetDeveloperId);
    logger.info("Member removed via HTTP", { targetDeveloperId, teamId: authCtx.teamId, requestId });
    return jsonResponse({ success: true }, 200, requestId, devIdHeaders(authCtx.developerId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Failed to remove member", { error: msg, requestId });
    return jsonResponse({ error: "Failed to remove member" }, 500, requestId, devIdHeaders(authCtx.developerId));
  }
}

// ---------------------------------------------------------------------------
// /mcp request handler
// ---------------------------------------------------------------------------

/**
 * Handles a single /mcp request end-to-end:
 *  1. Authenticate via Bearer token.
 *  2. Create a stateless transport + scoped MCP server.
 *  3. Connect and delegate to the transport.
 *
 * @param req       - Incoming Web Standard Request.
 * @param db        - Shared database connection.
 * @param requestId - UUID for this request (added to response headers).
 */
async function handleMcpRequest(
  req: Request,
  db: Database,
  requestId: string,
): Promise<Response> {
  let authCtx: AuthContext;
  try {
    authCtx = await authenticateRequest(req, db);
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn("Authentication failed", { message: err.message, requestId });
      return unauthorizedResponse(err.message, requestId);
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Unexpected auth error", { error: msg, requestId });
    return internalErrorResponse("Authentication error", requestId);
  }

  const mcpServer = createMcpServer(db, authCtx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });

  try {
    await mcpServer.connect(transport);
    const mcpResponse = await transport.handleRequest(req);
    const metaResponse = withMeta(mcpResponse, requestId);
    // Embed developerId for the outer fetch handler's access log (stripped there).
    const headers = new Headers(metaResponse.headers);
    if (authCtx.developerId !== null) {
      headers.set("x-developer-id", authCtx.developerId);
    }
    return new Response(metaResponse.body, {
      status: metaResponse.status,
      statusText: metaResponse.statusText,
      headers,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("MCP request handling failed", {
      teamId: authCtx.teamId,
      developerId: authCtx.developerId,
      error: msg,
      requestId,
    });
    return internalErrorResponse("Internal server error", requestId);
  }
}

// ---------------------------------------------------------------------------
// Access log helper
// ---------------------------------------------------------------------------

/**
 * Emits a structured access log entry via logger.info.
 */
function logAccess(
  requestId: string,
  method: string,
  path: string,
  developerId: string | null,
  start: number,
  status: number,
): void {
  const latencyMs = Math.round(performance.now() - start);
  logger.info("access", { requestId, method, path, developerId, latencyMs, status });
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
export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
  const { port: startPort, dbPath } = options;

  const config = loadConfig();
  logger.setLevel(config.logLevel);

  const db = initDatabase(dbPath);
  initTeamSchema(db);
  initActivitySchema(db);

  const tryStart = (port: number): any => {
    try {
      return Bun.serve({
        port,
        async fetch(req: Request): Promise<Response> {
          const start = performance.now();
          const requestId = crypto.randomUUID();
          const url = new URL(req.url);
          const method = req.method.toUpperCase();
          const path = url.pathname;

          logger.debug("HTTP request", { method, path, requestId });

          // ------------------------------------------------------------------
          // CORS preflight
          // ------------------------------------------------------------------
          if (method === "OPTIONS") {
            const res = new Response(null, {
              status: 204,
              headers: { ...CORS_HEADERS, "X-Request-Id": requestId },
            });
            logAccess(requestId, method, path, null, start, 204);
            return res;
          }

          let response: Response;

          // ------------------------------------------------------------------
          // Route dispatch
          // ------------------------------------------------------------------
          if (path === "/health" && method === "GET") {
            response = jsonResponse(
              { status: "ok", service: "gyst", version: "0.1.0" },
              200,
              requestId,
            );
          } else if (path === "/mcp" && (method === "POST" || method === "GET")) {
            response = await handleMcpRequest(req, db, requestId);
          } else if (path === "/team" && method === "POST") {
            response = await handleCreateTeam(req, db, requestId);
          } else if (path === "/team/invite" && method === "POST") {
            response = await handleCreateInvite(req, db, requestId);
          } else if (path === "/team/join" && method === "POST") {
            response = await handleJoinTeam(req, db, requestId);
          } else if (path === "/team/members" && method === "GET") {
            response = await handleListMembers(req, db, requestId);
          } else {
            const memberDeleteMatch = /^\/team\/members\/([^/]+)$/.exec(path);
            if (memberDeleteMatch !== null && method === "DELETE") {
              response = await handleRemoveMember(req, db, requestId, memberDeleteMatch[1]!);
            } else {
              response = notFoundResponse(requestId);
            }
          }

          // Read the internal developer-id header (set by auth-resolving handlers)
          // before stripping it so it never reaches the HTTP client.
          const developerId = response.headers.get("x-developer-id");
          if (developerId !== null) {
            const stripped = new Headers(response.headers);
            stripped.delete("x-developer-id");
            response = new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: stripped,
            });
          }

          logAccess(requestId, method, path, developerId, start, response.status);
          return response;
        },
      });
    } catch (err: any) {
      if (err.code === "EADDRINUSE" && port < startPort + 10) {
        logger.info("http-port-in-use", { port, next: port + 1 });
        return tryStart(port + 1);
      }
      throw err;
    }
  };

  const server = tryStart(startPort);

  logger.info("Gyst HTTP server started", { port: server.port, dbPath });

  process.stdout.write(
    `Gyst HTTP server listening on http://localhost:${server.port}\n`,
  );
  process.stdout.write(`  MCP endpoint : POST http://localhost:${server.port}/mcp\n`);
  process.stdout.write(`  Health check : GET  http://localhost:${server.port}/health\n`);

  return {
    stop: () => {
      server.stop(true);
      logger.info("Gyst HTTP server stopped", { port: server.port });
    },
  };
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
