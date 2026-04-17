/**
 * Dashboard HTTP server for Gyst.
 *
 * Serves a read-only JSON API and a static HTML dashboard over HTTP.
 * All routes are unauthenticated and read-only — this server is intended
 * for local / intranet use only.
 */

import type { Database } from "bun:sqlite";
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

  return {
    ...counts,
    structuralNodes: structural?.nodes ?? 0,
    structuralEdges: structural?.edges ?? 0,
    byType,
    byScope,
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
 * Fetches curated entries with optional scope filtering.
 */
function getEntriesByScope(db: Database, scope?: string, limit: number = 100): any[] {
  if (scope) {
    return db
      .query("SELECT * FROM entries WHERE scope = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?")
      .all(scope, limit);
  }
  return db
    .query("SELECT * FROM entries WHERE status = 'active' ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

// ---------------------------------------------------------------------------
// Review queue helpers
// ---------------------------------------------------------------------------

/** A single item in the review queue. */
interface ReviewItem {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly type: string;
  readonly confidence: number;
  readonly reason: string;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly lastConfirmed: string | null;
}

interface EntryRow {
  id: string;
  title: string;
  content: string;
  type: string;
  confidence: number;
  created_at: string;
  last_confirmed: string | null;
}

/**
 * Builds the review queue by gathering entries from four sources:
 * low confidence, stale, borderline, and flagged. De-duplicates by entry ID
 * and preserves source-priority ordering. Returns at most 50 items.
 */
function buildReviewQueue(db: Database): ReadonlyArray<ReviewItem> {
  const seen = new Set<string>();
  const items: ReviewItem[] = [];

  const toItem = (row: EntryRow, reason: string, reasonCode: string): ReviewItem => ({
    id: row.id,
    title: row.title,
    content: row.content.length > 200 ? row.content.slice(0, 200) : row.content,
    type: row.type,
    confidence: row.confidence,
    reason,
    reasonCode,
    createdAt: row.created_at,
    lastConfirmed: row.last_confirmed ?? null,
  });

  const push = (rows: readonly EntryRow[], reason: string, reasonCode: string): void => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(toItem(row, reason, reasonCode));
    }
  };

  // 1. Low confidence
  const lowConf = db
    .query<EntryRow, []>(
      "SELECT id, title, content, type, confidence, created_at, last_confirmed FROM entries WHERE status = 'active' AND confidence < 0.4 ORDER BY confidence ASC",
    )
    .all();
  push(lowConf, "Low confidence \u2014 needs review", "low_confidence");

  // 2. Stale (last_confirmed is NULL or older than 60 days)
  const stale = db
    .query<EntryRow, []>(
      `SELECT id, title, content, type, confidence, created_at, last_confirmed
       FROM entries
       WHERE status = 'active'
         AND (last_confirmed IS NULL OR last_confirmed < datetime('now', '-60 days'))
       ORDER BY last_confirmed ASC`,
    )
    .all();
  push(stale, "Not confirmed in 60+ days", "stale");

  // 3. Borderline classifier
  const borderline = db
    .query<EntryRow, []>(
      "SELECT id, title, content, type, confidence, created_at, last_confirmed FROM entries WHERE status = 'active' AND confidence >= 0.4 AND confidence <= 0.6 ORDER BY confidence ASC",
    )
    .all();
  push(borderline, "Borderline classification", "borderline");

  // 4. Flagged (notes contain 'flagged' or received negative feedback)
  const flagged = db
    .query<EntryRow, []>(
      `SELECT DISTINCT e.id, e.title, e.content, e.type, e.confidence, e.created_at, e.last_confirmed
       FROM entries e
       INNER JOIN feedback f ON f.entry_id = e.id
       WHERE e.status = 'active'
         AND (LOWER(f.note) LIKE '%flagged%' OR f.helpful = 0)
       ORDER BY f.timestamp DESC`,
    )
    .all();
  push(flagged, "Flagged by teammate", "flagged");

  return items.slice(0, 50);
}

/**
 * Confirms a review-queue entry: bumps confidence and updates last_confirmed.
 */
function confirmEntry(db: Database, entryId: string): boolean {
  const row = db
    .query<{ id: string; confidence: number }, [string]>(
      "SELECT id, confidence FROM entries WHERE id = ? AND status = 'active'",
    )
    .get(entryId);
  if (!row) return false;

  const newConfidence = Math.max(row.confidence + 0.15, 0.8);
  const now = new Date().toISOString();
  db.query<void, [number, string, string]>(
    "UPDATE entries SET confidence = ?, last_confirmed = ? WHERE id = ?",
  ).run(newConfidence, now, entryId);
  return true;
}

/**
 * Archives a review-queue entry by setting its status to 'archived'.
 */
function archiveEntry(db: Database, entryId: string): boolean {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM entries WHERE id = ? AND status = 'active'",
    )
    .get(entryId);
  if (!row) return false;

  db.query<void, [string]>(
    "UPDATE entries SET status = 'archived' WHERE id = ?",
  ).run(entryId);
  return true;
}

// ---------------------------------------------------------------------------
// Route regex helpers
// ---------------------------------------------------------------------------

const GRAPH_NODE_RE = /^\/api\/graph\/([^/]+)$/;
const REVIEW_ACTION_RE = /^\/api\/review-queue\/([^/]+)\/(confirm|archive|skip)$/;

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
  
  // Ensure activity log table exists before serving API
  initActivitySchema(db);

  const tryStart = (port: number): any => {
    try {
      return Bun.serve({
        port,
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
                  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type",
                  "X-Request-Id": requestId,
                },
              });
              logAccess(requestId, method, path, start, 204);
              return res;
            }

            // POST: review-queue actions (confirm / archive / skip)
            if (method === "POST") {
              const actionMatch = REVIEW_ACTION_RE.exec(path);
              if (actionMatch !== null) {
                const entryId = decodeURIComponent(actionMatch[1] ?? "");
                const action = actionMatch[2];

                if (action === "skip") {
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                }

                if (action === "confirm") {
                  const ok = confirmEntry(db, entryId);
                  if (!ok) {
                    logAccess(requestId, method, path, start, 404);
                    return jsonResponse(
                      { error: "Entry not found" },
                      404,
                      requestId,
                    );
                  }
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                }

                if (action === "archive") {
                  const ok = archiveEntry(db, entryId);
                  if (!ok) {
                    logAccess(requestId, method, path, start, 404);
                    return jsonResponse(
                      { error: "Entry not found" },
                      404,
                      requestId,
                    );
                  }
                  logAccess(requestId, method, path, start, 200);
                  return jsonResponse({ ok: true }, 200, requestId);
                }
              }
            }

            // Static HTML root — served from inlined bundle string (no file dependency)
            if (method === "GET" && path === "/") {
              const res = new Response(DASHBOARD_HTML as unknown as string, {
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "X-Request-Id": requestId,
                },
              });
              logAccess(requestId, method, path, start, 200);
              return res;
            }

            // JSON API routes
            if (method === "GET") {
              if (path === "/api/stats") {
                const data = buildStats(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/graph") {
                const data = getFullGraph(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
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
                const data = getEntriesByScope(db, scope, limit);
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

              if (path === "/api/review-queue") {
                const data = buildReviewQueue(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(data, 200, requestId);
              }

              if (path === "/api/uniformity") {
                const { computeUniformityScore } = await import("../store/uniformity.js");
                const report = computeUniformityScore(db);
                logAccess(requestId, method, path, start, 200);
                return jsonResponse(report, 200, requestId);
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

  logger.info("dashboard-server-started", { url: boundUrl });

  if (options.openBrowser !== false) {
    const platform = process.platform;
    if (platform === "darwin") {
      await Bun.$`open ${boundUrl}`.quiet().nothrow();
    } else if (platform === "linux") {
      await Bun.$`xdg-open ${boundUrl}`.quiet().nothrow();
    }
  }

  return {
    url: boundUrl,
    stop: () => {
      server.stop();
    },
  };
}
