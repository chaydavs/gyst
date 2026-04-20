/**
 * Dashboard HTTP server for Gyst.
 *
 * Serves a read-only JSON API and a static HTML dashboard over HTTP.
 * All routes are unauthenticated and read-only — this server is intended
 * for local / intranet use only.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
// @ts-ignore — Bun bundler resolves this as a text import (inlined at build time)
import DASHBOARD_HTML from "./index.html" with { type: "text" };
import { logger } from "../utils/logger.js";
import {
  getFullGraph,
  getNeighbors,
  getFileSubgraph,
  getClusters,
  getHubs,
  findPath,
} from "../store/graph.js";
import { getRecentActivity, initActivitySchema } from "../server/activity.js";
import { searchByBM25 } from "../store/search.js";
import { initAnalyticsSchema, getAnalyticsSummary } from "../utils/analytics.js";
import { initDriftSchema, computeDriftReport, addAnchorQuery, listAnchorQueries, takeDriftSnapshot } from "../utils/drift.js";

// ---------------------------------------------------------------------------
// Path resolution for React UI build output
// ---------------------------------------------------------------------------
//
// import.meta.url differs between dev and bundled modes:
//   Dev (src/dashboard/server.ts):  fileDir = src/dashboard/  → dist at ./dist
//   Bundled (dist/cli.js):          fileDir = dist/            → dist at ../src/dashboard/dist
//
// Probe in order and use the first candidate that exists on disk.

const _fileDir = dirname(fileURLToPath(import.meta.url));
const DIST_DIR: string = (() => {
  const candidates = [
    join(_fileDir, "dist"),                        // dev: src/dashboard/ → src/dashboard/dist/
    join(_fileDir, "../src/dashboard/dist"),        // bundled: dist/      → src/dashboard/dist/
    join(_fileDir, "../../src/dashboard/dist"),     // deep-bundled fallback
  ];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? candidates[0];
})();

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Handle returned from startDashboardServer, used to shut the server down. */
export interface DashboardServerHandle {
  readonly url: string;
  readonly stop: () => void;
}

/** Options accepted by startDashboardServer. */
export interface DashboardServerOptions {
  readonly db: Database;
  readonly port: number;
  readonly openBrowser?: boolean;
}

// ---------------------------------------------------------------------------
// CORS / response helpers (copied locally — do NOT import from http.ts)
// ---------------------------------------------------------------------------

const CORS_ORIGIN = process.env["GYST_CORS_ORIGIN"] ?? "*";

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Content-Type header value for a given file extension.
 */
function contentTypeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html": return "text/html; charset=utf-8";
    case "js":   return "application/javascript";
    case "css":  return "text/css";
    case "map":  return "application/json";
    default:     return "application/octet-stream";
  }
}

/**
 * Serves a file from the dist directory with appropriate Content-Type.
 * Returns null if the file does not exist.
 */
function serveDistFile(filePath: string, requestId: string): Response | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": contentTypeFor(filePath),
      "X-Request-Id": requestId,
      "Access-Control-Allow-Origin": CORS_ORIGIN,
    },
  });
}

// ---------------------------------------------------------------------------
// Server-Sent Events — real-time push to connected dashboard tabs
// ---------------------------------------------------------------------------

/** Live SSE client controllers. Module-level so all request handlers share it. */
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

/**
 * Broadcasts a JSON payload to all connected SSE clients.
 * Stale controllers (closed tabs) are automatically removed.
 */
function broadcastSSE(data: Record<string, unknown>): void {
  if (sseClients.size === 0) return;
  const msg = sseEncoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(msg);
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for write endpoints
// ---------------------------------------------------------------------------

const CreateEntrySchema = z.object({
  type: z.enum(["error_pattern", "convention", "decision", "learning", "ghost_knowledge"]),
  title: z.string().min(1),
  content: z.string().min(1),
  scope: z.string(),
  tags: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
});

const UpdateEntrySchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  scope: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const FeedbackSchema = z.object({
  helpful: z.boolean(),
  note: z.string().optional(),
});

/**
 * Builds a JSON response with standard CORS and request-id headers.
 */
function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      "Access-Control-Allow-Origin": CORS_ORIGIN,
    },
  });
}

/**
 * Emits a structured access-log entry for every dashboard request.
 */
function logAccess(
  requestId: string,
  method: string,
  path: string,
  start: number,
  status: number,
): void {
  const latencyMs = Math.round(performance.now() - start);
  logger.info("dashboard-access", { requestId, method, path, latencyMs, status });
}

// ---------------------------------------------------------------------------
// /api/stats helper
// ---------------------------------------------------------------------------

interface StatsRow {
  entries: number;
  relationships: number;
  coRetrievals: number;
}

interface TypeRow {
  type: string;
  n: number;
}

interface ScopeRow {
  scope: string;
  n: number;
}

/**
 * Runs three aggregate SQL queries and returns a stats summary object.
 */
function buildStats(db: Database): Record<string, unknown> {
  const counts = db
    .query<StatsRow, []>(
      `SELECT
        (SELECT COUNT(*) FROM entries WHERE status='active')  AS entries,
        (SELECT COUNT(*) FROM relationships)                  AS relationships,
        (SELECT COUNT(*) FROM co_retrievals)                  AS coRetrievals`,
    )
    .get();

  // Adjacent structural index (graphify AST) — reported separately so the
  // dashboard can surface both layers without conflating their scales.
  const structural = db
    .query<{ nodes: number; edges: number }, []>(
      `SELECT
        (SELECT COUNT(*) FROM structural_nodes) AS nodes,
        (SELECT COUNT(*) FROM structural_edges) AS edges`,
    )
    .get();

  const byTypeRows = db
    .query<TypeRow, []>(
      "SELECT type, COUNT(*) AS n FROM entries WHERE status='active' GROUP BY type",
    )
    .all();

  const byScopeRows = db
    .query<ScopeRow, []>(
      "SELECT scope, COUNT(*) AS n FROM entries WHERE status='active' GROUP BY scope",
    )
    .all();

  const byType: Record<string, number> = {};
  for (const r of byTypeRows) {
    byType[r.type] = r.n;
  }

  const byScope: Record<string, number> = {};
  for (const r of byScopeRows) {
    byScope[r.scope] = r.n;
  }

  const avgConfidenceRow = db
    .query<{ avg: number | null }, []>(
      "SELECT AVG(confidence) AS avg FROM entries WHERE status='active' AND type NOT IN ('structural','md_doc')",
    )
    .get();
  const avgConfidence = avgConfidenceRow?.avg != null
    ? Math.round(avgConfidenceRow.avg * 100)
    : null;

  return {
    ...counts,
    structuralNodes: structural?.nodes ?? 0,
    structuralEdges: structural?.edges ?? 0,
    byType,
    byScope,
    avgConfidence,
  };
}

/**
 * Fetches recent capture sessions.
 */
function getRecentSessions(db: Database, limit: number = 20): any[] {
  return db
    .query("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
    .all(limit);
}

/**
 * Fetches recent events from the queue.
 */
function getRecentEvents(db: Database, limit: number = 100): any[] {
  return db
    .query("SELECT * FROM event_queue ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

/**
 * Maps a raw SQLite entries row (snake_case) to the camelCase shape the UI expects.
 */
function mapEntryRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id:            row["id"],
    type:          row["type"],
    title:         row["title"],
    content:       row["content"],
    scope:         row["scope"],
    confidence:    row["confidence"],
    createdAt:     row["created_at"],
    lastConfirmed: row["last_confirmed"],
    sourceCount:   row["source_count"] ?? 0,
    sourceTool:    row["source_tool"] ?? null,
    developerId:   row["developer_id"] ?? null,
  };
}

/**
 * Fetches curated entries with optional scope filtering.
 * `scope` may be a single scope name or a comma-separated list (e.g. "personal,project").
 */
function getEntriesByScope(db: Database, scope?: string, limit: number = 100, developerId?: string): Record<string, unknown>[] {
  let rows: Record<string, unknown>[];
  const scopes = scope ? scope.split(",").map((s) => s.trim()).filter(Boolean) : [];

  if (scopes.length === 1) {
    const baseSql = developerId
      ? "SELECT * FROM entries WHERE scope = ? AND developer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM entries WHERE scope = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?";
    rows = (developerId
      ? db.query(baseSql).all(scopes[0], developerId, limit)
      : db.query(baseSql).all(scopes[0], limit)) as Record<string, unknown>[];
  } else if (scopes.length > 1) {
    const placeholders = scopes.map(() => "?").join(", ");
    const baseSql = developerId
      ? `SELECT * FROM entries WHERE scope IN (${placeholders}) AND developer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM entries WHERE scope IN (${placeholders}) AND status = 'active' ORDER BY created_at DESC LIMIT ?`;
    rows = (developerId
      ? db.query(baseSql).all(...scopes, developerId, limit)
      : db.query(baseSql).all(...scopes, limit)) as Record<string, unknown>[];
  } else {
    const baseSql = developerId
      ? "SELECT * FROM entries WHERE developer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM entries WHERE status = 'active' ORDER BY created_at DESC LIMIT ?";
    rows = (developerId
      ? db.query(baseSql).all(developerId, limit)
      : db.query(baseSql).all(limit)) as Record<string, unknown>[];
  }
  return rows.map(mapEntryRow);
}

// ---------------------------------------------------------------------------
// Route regex helpers
// ---------------------------------------------------------------------------

const GRAPH_NODE_RE = /^\/api\/graph\/([^/]+)$/;
const ENTRY_ID_RE = /^\/api\/entries\/([^/]+)$/;
const ENTRY_ACTION_RE = /^\/api\/entries\/([^/]+)\/(feedback|promote)$/;
const REVIEW_ACTION_RE = /^\/api\/review-queue\/([^/]+)\/(confirm|archive|skip)$/;
const ASSETS_RE = /^\/assets\//;
const TEAM_MEMBER_ID_RE = /^\/api\/team\/members\/([^/]+)$/;
const TEAM_MEMBER_STATS_RE = /^\/api\/team\/members\/([^/]+)\/stats$/;
const TEAM_INVITE_HASH_RE  = /^\/api\/team\/invites\/([^/]+)$/;
const ANCHOR_ID_RE         = /^\/api\/drift\/anchors\/([^/]+)$/;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Starts the dashboard HTTP server and optionally opens a browser tab.
 *
 * @param options - Database handle, port (use 0 for OS-assigned), and
 *   whether to auto-open the browser (defaults to true).
 * @returns A handle containing the bound URL and a stop() callback.
 */
export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const { db } = options;
  
  // Ensure supporting tables exist before serving API
  initActivitySchema(db);
  initAnalyticsSchema(db);
  initDriftSchema(db);
  takeDriftSnapshot(db); // take today's snapshot on server start (idempotent)

  const tryStart = (port: number): any => {
    try {
      return Bun.serve({
        port,
        idleTimeout: 0,   // disable per-request timeout so SSE streams don't get killed
        async fetch(req: Request): Promise<Response> {
          const requestId = crypto.randomUUID();
          const start = performance.now();
          const method = req.method.toUpperCase();
          const url = new URL(req.url);
          const path = url.pathname;

          try {
            // CORS preflight
            if (method === "OPTIONS") {
              const res = new Response(null, {
                status: 204,
                headers: {
                  "Access-Control-Allow-Origin": CORS_ORIGIN,
                  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type",
                  "X-Request-Id": requestId,
                },
              });
              logAccess(requestId, method, path, start, 204);
              return res;
            }

            // Legacy D3 dashboard — keep old inlined HTML accessible at /legacy
            if (method === "GET" && path === "/legacy") {
              const res = new Response(DASHBOARD_HTML as unknown as string, {
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "X-Request-Id": requestId,
                },
              });
              logAccess(requestId, method, path, start, 200);
              return res;
            }

            // React root — serve dist/index.html if available, fall back to old HTML
            if (method === "GET" && path === "/") {
              const indexPath = join(DIST_DIR, "index.html");
              const distRes = serveDistFile(indexPath, requestId);
              if (distRes !== null) {
                logAccess(requestId, method, path, start, 200);
                return distRes;
              }
              // Fallback: legacy inlined HTML
              const res = new Response(DASHBOARD_HTML as unknown as string, {
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "X-Request-Id": requestId,
                },
              });
              logAccess(requestId, method, path, start, 200);
              return res;
            }

            // Static assets from dist/assets/
            if (method === "GET" && ASSETS_RE.test(path)) {
              const filename = path.replace(/^\/assets\//, "");
              const assetPath = join(DIST_DIR, "assets", filename);
              const assetRes = serveDistFile(assetPath, requestId);
              if (assetRes !== null) {
                logAccess(requestId, method, path, start, 200);
                return assetRes;
              }
              logAccess(requestId, method, path, start, 404);
              return jsonResponse({ error: "Asset not found" }, 404, requestId);
            }

            // SSE — real-time event stream for connected dashboard tabs
            if (method === "GET" && path === "/api/stream") {
              let ctrl!: ReadableStreamDefaultController<Uint8Array>;
              const stream = new ReadableStream<Uint8Array>({
                start(c) {
                  ctrl = c;
                  sseClients.add(c);
                  // Send an immediate ping so the client knows the connection is live
                  c.enqueue(sseEncoder.encode(`: connected\n\n`));
                },
                cancel() {
                  sseClients.delete(ctrl);
                },
              });
              logAccess(requestId, method, path, start, 200);
              return new Response(stream, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                  "X-Accel-Buffering": "no",
                  "X-Request-Id": requestId,
                  "Access-Control-Allow-Origin": CORS_ORIGIN,
                },
              });
            }

            // JSON API routes
            if (method === "GET") {
              if (path === "/api/stats") {
                const data = buildStats(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/analytics") {
                const data = getAnalyticsSummary(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/drift") {
                const report = computeDriftReport(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(report, 200, requestId);
              }

              if (path === "/api/drift/anchors") {
                const anchors = listAnchorQueries(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(anchors, 200, requestId);
              }

              if (path === "/api/graph") {
                const data = getFullGraph(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/docs") {
                const docs = db.query<{
                  id: string; title: string; content: string; file_path: string | null;
                  created_at: string; last_confirmed: string; confidence: number;
                }, []>(
                  "SELECT id, title, content, file_path, created_at, last_confirmed, confidence FROM entries WHERE type='md_doc' AND status='active' ORDER BY last_confirmed DESC"
                ).all();
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(docs, 200, requestId);
              }

              const DOCS_ENTRY_RE = /^\/api\/docs\/([^/]+)$/;
              const docsEntryMatch = DOCS_ENTRY_RE.exec(path);
              if (docsEntryMatch) {
                const docId = decodeURIComponent(docsEntryMatch[1] ?? "");
                const doc = db.query<{
                  id: string; title: string; content: string; file_path: string | null;
                  created_at: string; last_confirmed: string; confidence: number;
                }, [string]>(
                  "SELECT id, title, content, file_path, created_at, last_confirmed, confidence FROM entries WHERE id=? AND type='md_doc'"
                ).get(docId);
                if (!doc) {
                  logAccess(requestId, method, path, start, 404);
                  return jsonResponse({ error: "not found" }, 404, requestId);
                }
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(doc, 200, requestId);
              }

              // /api/graph/:id  — must come before the bare /api/graph check
              const graphNodeMatch = GRAPH_NODE_RE.exec(path);
              if (graphNodeMatch !== null) {
                const entryId = decodeURIComponent(graphNodeMatch[1] ?? "");
                const data = getNeighbors(db, entryId);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/files") {
                const raw = url.searchParams.get("paths") ?? "";
                const paths = raw.length > 0 ? raw.split(",").map((p) => p.trim()) : [];
                const data = getFileSubgraph(db, paths);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/clusters") {
                const data = getClusters(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/hubs") {
                const limitParam = url.searchParams.get("limit");
                const limit = limitParam !== null ? parseInt(limitParam, 10) || 20 : 20;
                const data = getHubs(db, limit);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/path") {
                const from = url.searchParams.get("from") ?? "";
                const to = url.searchParams.get("to") ?? "";
                if (from.length === 0 || to.length === 0) {
                  logAccess(requestId, method, path, start, 400);
                  return jsonResponse(
                    { error: "Missing 'from' or 'to' query parameters" },
                    400,
                    requestId,
                  );
                }
                const data = findPath(db, from, to);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/activity") {
                const hoursParam = url.searchParams.get("hours");
                const hours = hoursParam !== null ? parseInt(hoursParam, 10) || 24 : 24;
                const data = getRecentActivity(db, "local", hours);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/events") {
                const limitParam = url.searchParams.get("limit");
                const limit = limitParam !== null ? parseInt(limitParam, 10) || 100 : 100;
                const data = getRecentEvents(db, limit);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/entries") {
                const scope = url.searchParams.get("scope") || undefined;
                const limitParam = url.searchParams.get("limit");
                const limit = limitParam !== null ? parseInt(limitParam, 10) || 100 : 100;
                const developerId = url.searchParams.get("developerId") || undefined;
                const data = getEntriesByScope(db, scope, limit, developerId);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/sessions") {
                const limitParam = url.searchParams.get("limit");
                const limit = limitParam !== null ? parseInt(limitParam, 10) || 20 : 20;
                const data = getRecentSessions(db, limit);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              // /api/review-queue — error_pattern + ghost_knowledge needing human verification
              if (path === "/api/review-queue") {
                try {
                  interface ReviewRow {
                    id: string; title: string; type: string; content: string;
                    confidence: number; created_at: string; last_confirmed: string;
                  }
                  const rows = db
                    .query<ReviewRow, []>(
                      `SELECT id, title, type, content, confidence, created_at, last_confirmed
                       FROM entries
                       WHERE status = 'active'
                         AND type IN ('error_pattern', 'ghost_knowledge')
                         AND (
                           confidence < 0.85
                           OR (type = 'ghost_knowledge' AND last_confirmed < datetime('now', '-30 days'))
                         )
                       ORDER BY confidence ASC
                       LIMIT 50`,
                    )
                    .all();
                  const enriched = rows.map((r) => ({
                    id: r.id,
                    title: r.title,
                    type: r.type,
                    content: r.content,
                    confidence: r.confidence,
                    reason: r.confidence < 0.85 ? "low confidence" : "stale — not confirmed in 30+ days",
                    createdAt: r.created_at,
                  }));
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(enriched, 200, requestId);
                } catch (err) {
                  logger.error("review-queue error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/search?q=&scope=&limit=
              if (path === "/api/search") {
                const q = url.searchParams.get("q") ?? "";
                const scope = url.searchParams.get("scope") || undefined;
                const limitParam = url.searchParams.get("limit");
                const limit = limitParam !== null ? parseInt(limitParam, 10) || 20 : 20;

                if (q.trim().length === 0) {
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse([], 200, requestId);
                }

                try {
                  // scope='team' → team+project entries only (team member view)
                  // no scope → solo/personal mode: include all entries (personal+team+project)
                  // developerId is not available in the dashboard HTTP context, so we use
                  // includeAllPersonal=true for solo mode to avoid filtering out personal entries.
                  const includeAllPersonal = !scope || scope !== 'team';
                  const bm25Results = searchByBM25(db, q, undefined, undefined, includeAllPersonal);
                  const topIds = bm25Results.slice(0, limit).map((r) => r.id);

                  interface EntrySnippetRow {
                    id: string;
                    title: string;
                    type: string;
                    scope: string;
                    confidence: number;
                    content: string;
                  }

                  const results = topIds.map((entryId) => {
                    const row = db
                      .query<EntrySnippetRow, [string]>(
                        "SELECT id, title, type, scope, confidence, content FROM entries WHERE id = ?",
                      )
                      .get(entryId);
                    if (row === null || row === undefined) {
                      return null;
                    }
                    const snippet =
                      typeof row.content === "string"
                        ? row.content.slice(0, 200).replace(/\n/g, " ")
                        : "";
                    const score =
                      bm25Results.find((r) => r.id === entryId)?.score ?? 0;
                    return {
                      id: row.id,
                      title: row.title,
                      type: row.type,
                      scope: row.scope,
                      confidence: row.confidence,
                      snippet,
                      score,
                    };
                  }).filter(Boolean);

                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(results, 200, requestId);
                } catch (err) {
                  logger.error("search error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/team/members
              if (path === "/api/team/members") {
                try {
                  interface MemberRow {
                    team_id: string;
                    developer_id: string;
                    display_name: string;
                    role: string;
                    joined_at: string;
                    entry_count: number;
                    last_active: string | null;
                  }
                  // Enrich with entry counts and last-seen from activity_log (graceful if missing)
                  const rows = db
                    .query<MemberRow, []>(
                      `SELECT tm.team_id, tm.developer_id, tm.display_name, tm.role, tm.joined_at,
                              COUNT(DISTINCT e.id) AS entry_count,
                              MAX(al.timestamp) AS last_active
                       FROM team_members tm
                       LEFT JOIN entries e ON e.developer_id = tm.developer_id AND e.status = 'active'
                       LEFT JOIN (SELECT developer_id, MAX(timestamp) AS timestamp FROM activity_log GROUP BY developer_id) al
                         ON al.developer_id = tm.developer_id
                       GROUP BY tm.developer_id
                       ORDER BY tm.joined_at ASC`,
                    )
                    .all();
                  const members = rows.map(r => ({
                    teamId: r.team_id,
                    developerId: r.developer_id,
                    displayName: r.display_name,
                    role: r.role,
                    joinedAt: r.joined_at,
                    entryCount: r.entry_count ?? 0,
                    lastActive: r.last_active ?? null,
                  }));
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(members, 200, requestId);
                } catch (_err) {
                  // team_members table may not exist yet — try simpler fallback
                  try {
                    interface SimpleMemberRow { team_id: string; developer_id: string; display_name: string; role: string; joined_at: string }
                    const rows2 = db.query<SimpleMemberRow, []>(
                      "SELECT team_id, developer_id, display_name, role, joined_at FROM team_members ORDER BY joined_at ASC"
                    ).all();
                    return jsonResponse(rows2.map(r => ({ teamId: r.team_id, developerId: r.developer_id, displayName: r.display_name, role: r.role, joinedAt: r.joined_at, entryCount: 0, lastActive: null })), 200, requestId);
                  } catch {
                    logAccess(requestId, method, path, start, 200);
                    return jsonResponse([], 200, requestId);
                  }
                }
              }

              // /api/team/info
              if (path === "/api/team/info") {
                try {
                  interface TeamInfoRow {
                    id: string;
                    name: string;
                    created_at: string;
                    member_count: number;
                  }
                  const row = db
                    .query<TeamInfoRow, []>(
                      `SELECT t.id, t.name, t.created_at, COUNT(m.developer_id) AS member_count
                       FROM teams t
                       LEFT JOIN team_members m ON m.team_id = t.id
                       GROUP BY t.id
                       LIMIT 1`,
                    )
                    .get();
                  if (row === null || row === undefined) {
                    logAccess(requestId, method, path, start, 200);
                    return jsonResponse(null, 200, requestId);
                  }
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(
                    {
                      id: row.id,
                      name: row.name,
                      createdAt: row.created_at,
                      memberCount: row.member_count,
                    },
                    200,
                    requestId,
                  );
                } catch (_err) {
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(null, 200, requestId);
                }
              }

              // /api/team/activity — recent activity log with display names + synthetic join events
              if (path === "/api/team/activity") {
                try {
                  const limitParam = url.searchParams.get("limit");
                  const limit = limitParam !== null ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50;

                  // Synthetic "joined" events from team_members
                  interface JoinRow { developer_id: string; display_name: string; joined_at: string }
                  const joinRows = db.query<JoinRow, []>(
                    "SELECT developer_id, display_name, joined_at FROM team_members ORDER BY joined_at DESC"
                  ).all();
                  const joinEvents = joinRows.map(r => ({
                    id: `join:${r.developer_id}`,
                    action: "joined",
                    developerId: r.developer_id,
                    displayName: r.display_name,
                    entryId: null as string | null,
                    timestamp: r.joined_at,
                  }));

                  // Real activity_log events joined with display names
                  interface ActivityRow { id: number; action: string; developer_id: string; entry_id: string | null; timestamp: string; display_name: string | null }
                  let logEvents: Array<{ id: string; action: string; developerId: string; displayName: string; entryId: string | null; timestamp: string }> = [];
                  try {
                    const logRows = db.query<ActivityRow, [number]>(
                      `SELECT al.id, al.action, al.developer_id, al.entry_id, al.timestamp,
                              tm.display_name
                       FROM activity_log al
                       LEFT JOIN team_members tm ON tm.developer_id = al.developer_id
                       ORDER BY al.timestamp DESC
                       LIMIT ?`
                    ).all(limit);
                    logEvents = logRows.map(r => ({
                      id: `act:${r.id}`,
                      action: r.action,
                      developerId: r.developer_id,
                      displayName: r.display_name ?? r.developer_id.slice(0, 8),
                      entryId: r.entry_id,
                      timestamp: r.timestamp,
                    }));
                  } catch {
                    // activity_log may not exist yet
                  }

                  // Merge and sort by timestamp desc, take top `limit`
                  const all = [...joinEvents, ...logEvents]
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                    .slice(0, limit);

                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(all, 200, requestId);
                } catch (err) {
                  logger.error("team/activity error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse([], 200, requestId);
                }
              }

              // /api/team/invites — pending (non-expired, non-revoked) invite keys
              if (path === "/api/team/invites") {
                try {
                  interface InviteRow {
                    key_hash: string;
                    created_at: string;
                    expires_at: string | null;
                  }
                  const rows = db
                    .query<InviteRow, []>(
                      `SELECT key_hash, created_at, expires_at FROM api_keys
                       WHERE type = 'invite' AND revoked = 0
                         AND (expires_at IS NULL OR expires_at > datetime('now'))
                       ORDER BY created_at DESC`,
                    )
                    .all();
                  const invites = rows.map(r => ({
                    keyHash: r.key_hash,
                    createdAt: r.created_at,
                    expiresAt: r.expires_at,
                  }));
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(invites, 200, requestId);
                } catch (_err) {
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse([], 200, requestId);
                }
              }

              // /api/team/members/:developerId/stats
              const memberStatsMatch = TEAM_MEMBER_STATS_RE.exec(path);
              if (memberStatsMatch !== null) {
                const devId = decodeURIComponent(memberStatsMatch[1] ?? "");
                try {
                  interface TypeCountRow { type: string; n: number }
                  const byType: Record<string, number> = {};
                  const typeRows = db
                    .query<TypeCountRow, [string]>(
                      `SELECT type, COUNT(*) AS n FROM entries
                       WHERE developer_id = ? AND status = 'active' GROUP BY type`,
                    )
                    .all(devId);
                  for (const r of typeRows) byType[r.type] = r.n;

                  interface ActivityRow { action: string; entry_id: string | null; created_at: string }
                  const recentActivity = db
                    .query<ActivityRow, [string]>(
                      `SELECT action, entry_id, created_at FROM activity_log
                       WHERE developer_id = ? ORDER BY created_at DESC LIMIT 15`,
                    )
                    .all(devId)
                    .map(r => ({ action: r.action, entryId: r.entry_id, createdAt: r.created_at }));

                  interface RecallCountRow { recallCount: number; learnCount: number }
                  const activityCounts = db
                    .query<RecallCountRow, [string]>(
                      `SELECT
                        SUM(CASE WHEN action='recall' OR action='search' THEN 1 ELSE 0 END) AS recallCount,
                        SUM(CASE WHEN action='learn' THEN 1 ELSE 0 END) AS learnCount
                       FROM activity_log WHERE developer_id = ?`,
                    )
                    .get(devId) ?? { recallCount: 0, learnCount: 0 };

                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ byType, recentActivity, ...activityCounts }, 200, requestId);
                } catch (_err) {
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ byType: {}, recentActivity: [], recallCount: 0, learnCount: 0 }, 200, requestId);
                }
              }

              // /api/health
              if (path === "/api/health") {
                try {
                  interface HealthRow {
                    entries_count: number;
                    last_updated: string | null;
                  }
                  const row = db
                    .query<HealthRow, []>(
                      `SELECT COUNT(*) AS entries_count, MAX(created_at) AS last_updated
                       FROM entries
                       WHERE status = 'active'`,
                    )
                    .get();
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(
                    {
                      status: "ok",
                      version: "0.1.15",
                      entriesCount: row?.entries_count ?? 0,
                      lastUpdated: row?.last_updated ?? null,
                    },
                    200,
                    requestId,
                  );
                } catch (err) {
                  logger.error("health error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/tools/detected
              if (path === "/api/tools/detected") {
                const home = process.env["HOME"] ?? "";
                const tools = [
                  {
                    name: "claude",
                    configPath: join(home, ".claude", "settings.json"),
                  },
                  {
                    name: "cursor",
                    configPath: join(home, ".cursor", "mcp.json"),
                  },
                  {
                    name: "codex",
                    configPath: join(home, ".codex", "config.yaml"),
                  },
                  {
                    name: "windsurf",
                    configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
                  },
                  {
                    name: "cline",
                    configPath: join(home, ".vscode", "extensions", "saoudrizwan.claude-dev-0.0.0", "config.json"),
                  },
                ];
                const detected = tools.map((t) => ({
                  name: t.name,
                  detected: existsSync(t.configPath),
                  configPath: t.configPath,
                }));
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(detected, 200, requestId);
              }

              // /api/entries/:id — single entry with relationships
              // (must come after all specific /api/entries/... paths)
              const entryIdGetMatch = ENTRY_ID_RE.exec(path);
              if (entryIdGetMatch !== null) {
                const id = decodeURIComponent(entryIdGetMatch[1] ?? "");
                try {
                  const entryRow = db
                    .query("SELECT * FROM entries WHERE id = ?")
                    .get(id) as Record<string, unknown> | null | undefined;
                  if (entryRow === null || entryRow === undefined) {
                    logAccess(requestId, method, path, start, 404);
                    return jsonResponse({ error: "Entry not found" }, 404, requestId);
                  }
                  // Flatten tag/file arrays to plain strings
                  const tagRows = db
                    .query<{ tag: string }, [string]>("SELECT tag FROM entry_tags WHERE entry_id = ?")
                    .all(id);
                  const fileRows = db
                    .query<{ file_path: string }, [string]>("SELECT file_path FROM entry_files WHERE entry_id = ?")
                    .all(id);
                  // Map relationship rows and enrich with related entry title
                  interface RelRow { source_id: string; target_id: string; type: string; strength: number }
                  const relRows = db
                    .query<RelRow, [string, string]>(
                      "SELECT source_id, target_id, type, strength FROM relationships WHERE source_id = ? OR target_id = ?",
                    )
                    .all(id, id);
                  const relationships = relRows.map((r) => {
                    const relatedId = r.source_id === id ? r.target_id : r.source_id;
                    const related = db
                      .query<{ title: string; type: string }, [string]>("SELECT title, type FROM entries WHERE id = ?")
                      .get(relatedId);
                    return {
                      id: `${r.source_id}_${r.target_id}_${r.type}`,
                      sourceId: r.source_id,
                      targetId: r.target_id,
                      type: r.type,
                      strength: r.strength,
                      relatedId,
                      relatedTitle: related?.title ?? relatedId,
                      relatedType: related?.type ?? null,
                    };
                  });
                  // Map sources to camelCase
                  interface SourceRow { id: string; entry_id: string; tool: string; developer_id: string | null; session_id: string | null; created_at: string }
                  const srcRows = db
                    .query<SourceRow, [string]>("SELECT * FROM sources WHERE entry_id = ?")
                    .all(id);
                  const sources = srcRows.map((s) => ({
                    id: s.id,
                    entryId: s.entry_id,
                    tool: s.tool,
                    developerId: s.developer_id,
                    sessionId: s.session_id,
                    createdAt: s.created_at,
                  }));
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(
                    {
                      ...mapEntryRow(entryRow),
                      tags: tagRows.map((t) => t.tag),
                      files: fileRows.map((f) => f.file_path),
                      relationships,
                      sources,
                    },
                    200,
                    requestId,
                  );
                } catch (err) {
                  logger.error("entries/:id error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // SPA fallback — any non-API GET serves dist/index.html
              if (!path.startsWith("/api/")) {
                const indexPath = join(DIST_DIR, "index.html");
                const spaRes = serveDistFile(indexPath, requestId);
                if (spaRes !== null) {
                  logAccess(requestId, method, path, start, 200);
                  return spaRes;
                }
              }

            }

            // ------------------------------------------------------------------
            // POST routes
            // ------------------------------------------------------------------

            if (method === "POST") {
              // /api/drift/anchors — add a golden probe query
              if (path === "/api/drift/anchors") {
                try {
                  const body = await req.json() as { query?: string };
                  const query = typeof body.query === "string" ? body.query.trim() : "";
                  if (query.length === 0) {
                    logAccess(requestId, method, path, start, 400);
                    return jsonResponse({ error: "query is required" }, 400, requestId);
                  }
                  addAnchorQuery(db, query);
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("add anchor error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/review-queue/:id/(confirm|archive|skip)
              const reviewActionMatch = REVIEW_ACTION_RE.exec(path);
              if (reviewActionMatch !== null) {
                const entryId = decodeURIComponent(reviewActionMatch[1] ?? "");
                const action = reviewActionMatch[2] as "confirm" | "archive" | "skip";
                try {
                  if (action === "confirm") {
                    db.run(
                      "UPDATE entries SET confidence = 1.0, last_confirmed = datetime('now') WHERE id = ?",
                      [entryId],
                    );
                  } else if (action === "archive") {
                    db.run("UPDATE entries SET status = 'archived' WHERE id = ?", [entryId]);
                  }
                  // skip — no DB change, just acknowledge
                  broadcastSSE({ type: "queue_changed" });
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("review-queue action error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/entries/:id/(feedback|promote)
              const entryActionMatch = ENTRY_ACTION_RE.exec(path);
              if (entryActionMatch !== null) {
                const entryId = decodeURIComponent(entryActionMatch[1] ?? "");
                const action = entryActionMatch[2] as "feedback" | "promote";

                if (action === "feedback") {
                  let body: unknown;
                  try {
                    body = await req.json();
                  } catch (_err) {
                    logAccess(requestId, method, path, start, 400);
                    return jsonResponse({ error: "Invalid JSON body" }, 400, requestId);
                  }
                  const parsed = FeedbackSchema.safeParse(body);
                  if (!parsed.success) {
                    logAccess(requestId, method, path, start, 400);
                    return jsonResponse(
                      { error: "Validation failed", details: parsed.error.flatten() },
                      400,
                      requestId,
                    );
                  }
                  const { helpful, note } = parsed.data;
                  const now = new Date().toISOString();
                  try {
                    db.run(
                      `CREATE TABLE IF NOT EXISTS feedback (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                         entry_id TEXT NOT NULL,
                         helpful INTEGER NOT NULL,
                         note TEXT,
                         created_at TEXT NOT NULL
                       )`,
                    );
                    db.run(
                      "INSERT INTO feedback (entry_id, helpful, note, created_at) VALUES (?, ?, ?, ?)",
                      [entryId, helpful ? 1 : 0, note ?? null, now],
                    );
                    if (helpful) {
                      db.run(
                        "UPDATE entries SET confidence = MIN(1.0, confidence + 0.02) WHERE id = ?",
                        [entryId],
                      );
                    } else {
                      db.run(
                        "UPDATE entries SET confidence = MAX(0.0, confidence - 0.05) WHERE id = ?",
                        [entryId],
                      );
                    }
                    logAccess(requestId, method, path, start, 200);
                    return jsonResponse({ ok: true }, 200, requestId);
                  } catch (err) {
                    logger.error("feedback error", {
                      error: err instanceof Error ? err.message : String(err),
                    });
                    logAccess(requestId, method, path, start, 500);
                    return jsonResponse({ error: "internal" }, 500, requestId);
                  }
                }

                if (action === "promote") {
                  try {
                    db.run(
                      "UPDATE entries SET scope = 'team' WHERE id = ? AND scope = 'personal'",
                      [entryId],
                    );
                    broadcastSSE({ type: "entries_changed" });
                    logAccess(requestId, method, path, start, 200);
                    return jsonResponse({ ok: true, id: entryId }, 200, requestId);
                  } catch (err) {
                    logger.error("promote error", {
                      error: err instanceof Error ? err.message : String(err),
                    });
                    logAccess(requestId, method, path, start, 500);
                    return jsonResponse({ error: "internal" }, 500, requestId);
                  }
                }
              }

              // /api/entries — create entry
              if (path === "/api/entries") {
                let body: unknown;
                try {
                  body = await req.json();
                } catch (_err) {
                  logAccess(requestId, method, path, start, 400);
                  return jsonResponse({ error: "Invalid JSON body" }, 400, requestId);
                }
                const parsed = CreateEntrySchema.safeParse(body);
                if (!parsed.success) {
                  logAccess(requestId, method, path, start, 400);
                  return jsonResponse(
                    { error: "Validation failed", details: parsed.error.flatten() },
                    400,
                    requestId,
                  );
                }
                const { type, title, content, scope, tags, files } = parsed.data;
                const id = crypto.randomUUID();
                const now = new Date().toISOString();
                try {
                  db.run(
                    `INSERT INTO entries (id, type, title, content, scope, status, confidence, created_at, last_confirmed)
                     VALUES (?, ?, ?, ?, ?, 'active', 0.7, ?, ?)`,
                    [id, type, title, content, scope, now, now],
                  );
                  if (tags !== undefined && tags.length > 0) {
                    for (const tag of tags) {
                      db.run(
                        "INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)",
                        [id, tag],
                      );
                    }
                  }
                  if (files !== undefined && files.length > 0) {
                    for (const filePath of files) {
                      db.run(
                        "INSERT INTO entry_files (entry_id, file_path) VALUES (?, ?)",
                        [id, filePath],
                      );
                    }
                  }
                  broadcastSSE({ type: "entries_changed" });
                  logAccess(requestId, method, path, start, 201);
                  return jsonResponse({ id, title, type, scope }, 201, requestId);
                } catch (err) {
                  logger.error("create entry error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/export-context — triggers context file regeneration (gyst export)
              if (path === "/api/export-context") {
                try {
                  // Fire-and-forget: spawn gyst export asynchronously so the response returns fast.
                  // We use Bun.spawn (non-blocking) instead of awaiting the full subprocess.
                  Bun.spawn(["bun", "run", "src/cli/index.ts", "export"], {
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore",
                  });
                  logAccess(requestId, method, path, start, 202);
                  return jsonResponse({ ok: true, message: "Context file regeneration started." }, 202, requestId);
                } catch (err) {
                  logger.error("export-context error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/shutdown — gracefully stop the dashboard server
              if (path === "/api/shutdown") {
                logAccess(requestId, method, path, start, 200);
                const response = jsonResponse({ ok: true, message: "Dashboard server shutting down." }, 200, requestId);
                // Give the response time to flush before exiting
                setTimeout(() => process.exit(0), 200);
                return response;
              }

              // /api/team — create a new team
              if (path === "/api/team") {
                try {
                  let body: unknown;
                  try { body = await req.json(); } catch (_e) { body = {}; }
                  const nameRaw = (body as Record<string, unknown>)?.name;
                  const name = typeof nameRaw === "string" && nameRaw.trim().length > 0
                    ? nameRaw.trim()
                    : "My Team";
                  db.run(`CREATE TABLE IF NOT EXISTS teams (
                    id TEXT NOT NULL PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                  )`);
                  const existing = db.query<{ id: string }, []>("SELECT id FROM teams LIMIT 1").get();
                  if (existing !== null && existing !== undefined) {
                    logAccess(requestId, method, path, start, 409);
                    return jsonResponse({ error: "Team already exists", teamId: existing.id }, 409, requestId);
                  }
                  const teamId = crypto.randomUUID();
                  const now = new Date().toISOString();
                  db.run("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)", [teamId, name, now]);
                  logAccess(requestId, method, path, start, 201);
                  return jsonResponse({ teamId, name }, 201, requestId);
                } catch (err) {
                  logger.error("create team error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/team/invite/email (must come before /api/team/invite)
              if (path === "/api/team/invite/email") {
                try {
                  interface TeamRow { id: string }
                  const team = db
                    .query<TeamRow, []>("SELECT id FROM teams LIMIT 1")
                    .get();
                  if (team === null || team === undefined) {
                    logAccess(requestId, method, path, start, 404);
                    return jsonResponse({ error: "No team configured" }, 404, requestId);
                  }
                  const inviteCode = crypto.randomUUID();
                  const now = new Date().toISOString();
                  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                  db.run(
                    `INSERT INTO api_keys (key_hash, team_id, type, created_at, expires_at, revoked, developer_id)
                     VALUES (?, ?, 'invite', ?, ?, 0, NULL)`,
                    [inviteCode, team.id, now, expiresAt],
                  );
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(
                    {
                      inviteCode,
                      expiresAt,
                      installCommand: `npx gyst-mcp install --team ${team.id} --invite ${inviteCode}`,
                      emailSent: false,
                      note: "No mailer configured — share the install command directly",
                    },
                    200,
                    requestId,
                  );
                } catch (err) {
                  logger.error("team/invite/email error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/team/invite
              if (path === "/api/team/invite") {
                try {
                  // Ensure teams + api_keys tables exist on installs that skipped `gyst setup`
                  db.run(`CREATE TABLE IF NOT EXISTS teams (
                    id TEXT NOT NULL PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                  )`);
                  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
                    key_hash TEXT NOT NULL PRIMARY KEY,
                    team_id TEXT NOT NULL,
                    type TEXT NOT NULL DEFAULT 'invite',
                    created_at TEXT NOT NULL,
                    expires_at TEXT,
                    revoked INTEGER NOT NULL DEFAULT 0,
                    developer_id TEXT
                  )`);
                  interface TeamRow { id: string }
                  let team = db
                    .query<TeamRow, []>("SELECT id FROM teams LIMIT 1")
                    .get();
                  // If no team exists yet, create a default one so invites always work
                  if (team === null || team === undefined) {
                    const defaultId = "default";
                    const now2 = new Date().toISOString();
                    db.run(
                      `INSERT OR IGNORE INTO teams (id, name, created_at) VALUES (?, 'My Team', ?)`,
                      [defaultId, now2],
                    );
                    team = { id: defaultId };
                  }
                  const inviteCode = crypto.randomUUID();
                  const now = new Date().toISOString();
                  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                  db.run(
                    `INSERT INTO api_keys (key_hash, team_id, type, created_at, expires_at, revoked, developer_id)
                     VALUES (?, ?, 'invite', ?, ?, 0, NULL)`,
                    [inviteCode, team.id, now, expiresAt],
                  );
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(
                    {
                      inviteCode,
                      expiresAt,
                      installCommand: `npx gyst-mcp install --team ${team.id} --invite ${inviteCode}`,
                    },
                    200,
                    requestId,
                  );
                } catch (err) {
                  logger.error("team/invite error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }
            }

            // ------------------------------------------------------------------
            // PATCH routes
            // ------------------------------------------------------------------

            if (method === "PATCH") {
              // /api/entries/:id — update entry
              const entryIdPatchMatch = ENTRY_ID_RE.exec(path);
              if (entryIdPatchMatch !== null) {
                const id = decodeURIComponent(entryIdPatchMatch[1] ?? "");
                let body: unknown;
                try {
                  body = await req.json();
                } catch (_err) {
                  logAccess(requestId, method, path, start, 400);
                  return jsonResponse({ error: "Invalid JSON body" }, 400, requestId);
                }
                const parsed = UpdateEntrySchema.safeParse(body);
                if (!parsed.success) {
                  logAccess(requestId, method, path, start, 400);
                  return jsonResponse(
                    { error: "Validation failed", details: parsed.error.flatten() },
                    400,
                    requestId,
                  );
                }
                const { title, content, scope, tags } = parsed.data;
                const now = new Date().toISOString();
                try {
                  const setClauses: string[] = ["updated_at = ?"];
                  const params: unknown[] = [now];
                  if (title !== undefined) {
                    setClauses.push("title = ?");
                    params.push(title);
                  }
                  if (content !== undefined) {
                    setClauses.push("content = ?");
                    params.push(content);
                  }
                  if (scope !== undefined) {
                    setClauses.push("scope = ?");
                    params.push(scope);
                  }
                  params.push(id);
                  db.run(
                    `UPDATE entries SET ${setClauses.join(", ")} WHERE id = ?`,
                    params as any[],
                  );
                  if (tags !== undefined) {
                    db.run("DELETE FROM entry_tags WHERE entry_id = ?", [id]);
                    for (const tag of tags) {
                      db.run(
                        "INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)",
                        [id, tag],
                      );
                    }
                  }
                  const updated = db
                    .query("SELECT * FROM entries WHERE id = ?")
                    .get(id);
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse(updated, 200, requestId);
                } catch (err) {
                  logger.error("update entry error", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }
            }

            // ------------------------------------------------------------------
            // DELETE routes
            // ------------------------------------------------------------------

            if (method === "DELETE") {
              // /api/entries/:id — hard-delete an entry and all related rows
              const ENTRY_ID_RE = /^\/api\/entries\/([^/]+)$/;
              const entryDeleteMatch = ENTRY_ID_RE.exec(path);
              if (entryDeleteMatch !== null) {
                const entryId = decodeURIComponent(entryDeleteMatch[1] ?? "");
                try {
                  db.transaction(() => {
                    db.run("DELETE FROM entry_tags WHERE entry_id = ?", [entryId]);
                    db.run("DELETE FROM entry_files WHERE entry_id = ?", [entryId]);
                    db.run("DELETE FROM sources WHERE entry_id = ?", [entryId]);
                    db.run("DELETE FROM co_retrievals WHERE entry_a = ? OR entry_b = ?", [entryId, entryId]);
                    db.run("DELETE FROM relationships WHERE entry_a = ? OR entry_b = ?", [entryId, entryId]);
                    db.run("DELETE FROM feedback WHERE entry_id = ?", [entryId]);
                    db.run("DELETE FROM entries WHERE id = ?", [entryId]);
                  })();
                  broadcastSSE({ type: "entries_changed" });
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("delete entry error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/team — dissolve the entire team (all members, keys, team row)
              if (path === "/api/team") {
                try {
                  db.transaction(() => {
                    // Remove all API keys for this team
                    try { db.run("DELETE FROM api_keys WHERE team_id IN (SELECT id FROM teams)"); } catch { /* table may not exist */ }
                    // Remove all members
                    try { db.run("DELETE FROM team_members"); } catch { /* table may not exist */ }
                    // Remove all activity log entries
                    try { db.run("DELETE FROM activity_log"); } catch { /* table may not exist */ }
                    // Remove the team itself
                    db.run("DELETE FROM teams");
                  })();
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("delete team error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/team/members/:developerId
              const memberDeleteMatch = TEAM_MEMBER_ID_RE.exec(path);
              if (memberDeleteMatch !== null) {
                const developerId = decodeURIComponent(memberDeleteMatch[1] ?? "");
                try {
                  db.run("DELETE FROM team_members WHERE developer_id = ?", [developerId]);
                  db.run("UPDATE api_keys SET revoked = 1 WHERE developer_id = ?", [developerId]);
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("remove member error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/drift/anchors/:id — remove an anchor query by id
              const anchorDeleteMatch = ANCHOR_ID_RE.exec(path);
              if (anchorDeleteMatch !== null) {
                const anchorId = decodeURIComponent(anchorDeleteMatch[1] ?? "");
                try {
                  db.run("DELETE FROM anchor_queries WHERE id = ?", [anchorId]);
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("remove anchor error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }

              // /api/team/invites/:keyHash
              const inviteDeleteMatch = TEAM_INVITE_HASH_RE.exec(path);
              if (inviteDeleteMatch !== null) {
                const keyHash = decodeURIComponent(inviteDeleteMatch[1] ?? "");
                try {
                  db.run("UPDATE api_keys SET revoked = 1 WHERE key_hash = ? AND type = 'invite'", [keyHash]);
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                } catch (err) {
                  logger.error("revoke invite error", { error: err instanceof Error ? err.message : String(err) });
                  logAccess(requestId, method, path, start, 500);
                  return jsonResponse({ error: "internal" }, 500, requestId);
                }
              }
            }

            // 404 fallthrough
            logAccess(requestId, method, path, start, 404);
            return jsonResponse({ error: "Not found" }, 404, requestId);
          } catch (err) {
            logger.error("dashboard handler error", {
              requestId,
              error: err instanceof Error ? err.message : String(err),
            });
            logAccess(requestId, method, path, start, 500);
            return jsonResponse({ error: "internal" }, 500, requestId);
          }
        },
      });
    } catch (err: any) {
      if (err.code === "EADDRINUSE" && port < options.port + 10) {
        logger.info("dashboard-port-in-use", { port, next: port + 1 });
        return tryStart(port + 1);
      }
      throw err;
    }
  };

  const server = tryStart(options.port);
  const boundUrl = `http://localhost:${server.port}`;

  // Background watcher: poll DB every 5s for externally-added entries
  // (written by MCP tools, git hooks, or the queue consumer — not via HTTP).
  // If counts change, broadcast so connected tabs refresh automatically.
  let _lastEntryCount = -1;
  let _lastEventId = -1;
  const _watcher = setInterval(() => {
    try {
      const entryRow = db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries WHERE status='active'")
        .get();
      const n = entryRow?.n ?? 0;
      if (_lastEntryCount >= 0 && n !== _lastEntryCount) {
        broadcastSSE({ type: "entries_changed", count: n });
      }
      _lastEntryCount = n;

      // Also watch event_queue for newly promoted entries (queue consumer ran)
      const evtRow = db
        .query<{ maxId: number }, []>("SELECT MAX(id) AS maxId FROM event_queue")
        .get();
      const maxId = evtRow?.maxId ?? 0;
      if (_lastEventId >= 0 && maxId > _lastEventId) {
        broadcastSSE({ type: "activity_changed" });
      }
      _lastEventId = maxId;
    } catch {
      // DB may not be ready yet — ignore
    }
  }, 5000);

  logger.info("dashboard-server-started", { url: boundUrl });

  if (options.openBrowser !== false) {
    const platform = process.platform;
    if (platform === "darwin") {
      // -u treats the argument as a URL (avoids path ambiguity).
      // Fallback to plain open if -u isn't supported on older macOS.
      const result = await Bun.$`open -u ${boundUrl}`.quiet().nothrow();
      if (result.exitCode !== 0) {
        await Bun.$`open ${boundUrl}`.quiet().nothrow();
      }
    } else if (platform === "linux") {
      await Bun.$`xdg-open ${boundUrl}`.quiet().nothrow();
    } else if (platform === "win32") {
      await Bun.$`cmd /c start ${boundUrl}`.quiet().nothrow();
    }
  }

  return {
    url: boundUrl,
    stop: () => {
      clearInterval(_watcher);
      server.stop();
    },
  };
}
