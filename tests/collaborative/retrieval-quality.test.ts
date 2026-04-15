/**
 * CODE Retrieval Quality Benchmark — Gyst
 *
 * Seeds 100 realistic TypeScript/Bun/Node production entries and measures
 * Mean Reciprocal Rank (MRR@5) across 6 query groups:
 *
 *   direct       — exact keyword match         target MRR@5 ≥ 0.90
 *   semantic     — related content-word match  target MRR@5 ≥ 0.75
 *   file-specific — searchByFilePath           target MRR@5 ≥ 0.85
 *   team-context — conventions and decisions   target MRR@5 ≥ 0.70
 *   cross-cutting — spans multiple types       target MRR@5 ≥ 0.55
 *   ghost        — ghost_knowledge entries     target MRR@5 ≥ 0.90
 *
 * Overall MRR@5 across all 30 queries: ≥ 0.75
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import {
  searchByFilePath,
  searchByGraph,
  reciprocalRankFusion,
} from "../../src/store/search.js";
import type { RankedResult } from "../../src/store/search.js";
import { runHybridSearch } from "../../src/store/hybrid.js";
import { initVectorStore, backfillVectors } from "../../src/store/embeddings.js";

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

let db: Database;

beforeAll(async () => {
  db = initDatabase(":memory:");
  seedAllEntries(db);
  initVectorStore(db);
  await backfillVectors(db);
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * ONE_DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

/**
 * Hybrid search: BM25 + optional file-path + graph, fused via RRF(k=60).
 */
async function hybridSearch(
  database: Database,
  query: string,
  files?: string[],
): Promise<RankedResult[]> {
  return runHybridSearch(database, query, {
    fileContext: files,
    useGraphGuidedSearch: true,
  });
}

// ---------------------------------------------------------------------------
// MRR calculation
// ---------------------------------------------------------------------------

/**
 * Computes MRR@k for a single query result list.
 * Returns 1/(rank) for the first relevant hit in the top-k, else 0.
 */
function mrrAtK(
  results: RankedResult[],
  relevantIds: string[],
  k: number = 5,
): number {
  const relevant = new Set(relevantIds);
  const topK = results.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i].id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Aggregates MRR@5 over a list of queries and their expected relevant IDs.
 */
async function groupMrr(
  queries: Array<{ query: string; relevantIds: string[] }>,
  searcher: (q: string) => Promise<RankedResult[]>,
): Promise<number> {
  if (queries.length === 0) return 0;
  let total = 0;
  for (const { query, relevantIds } of queries) {
    const results = await searcher(query);
    total += mrrAtK(results, relevantIds);
  }
  return total / queries.length;
}

// ---------------------------------------------------------------------------
// Seed data — 100 realistic entries
// ---------------------------------------------------------------------------

function seedAllEntries(database: Database): void {
  const entries: EntryRow[] = [
    // -------------------------------------------------------------------------
    // ERROR PATTERNS (30 entries)
    // -------------------------------------------------------------------------
    {
      id: "ep-01",
      type: "error_pattern",
      title: "ECONNREFUSED postgres port 5432 database connection refused",
      content:
        "PostgreSQL database connection refused on port 5432. Error: connect ECONNREFUSED 127.0.0.1:5432. " +
        "Root cause: database service is not running or credentials are wrong. " +
        "Fix: verify DATABASE_URL in environment variables, ensure postgres service is up, " +
        "check firewall rules. Common in CI when postgres container has not finished initialising.",
      files: ["src/db/prisma.ts", "src/api/users.ts"],
      tags: ["postgres", "connection", "database", "econnrefused"],
      errorSignature: "error connect econnrefused <addr> <n> postgres",
      confidence: 0.93,
      sourceCount: 7,
      createdAt: daysAgo(55),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "ep-02",
      type: "error_pattern",
      title: "Prisma P2002 unique constraint failed on email field",
      content:
        "Prisma throws P2002 Unique constraint failed when inserting a duplicate email address. " +
        "The error message includes the field name: 'Unique constraint failed on the fields: (`email`)'. " +
        "Fix: catch the Prisma error and return HTTP 409 Conflict with user-friendly message. " +
        "Never expose raw Prisma error codes to the client.",
      files: ["src/db/prisma.ts", "src/api/users.ts"],
      tags: ["prisma", "unique", "constraint", "email", "p2002"],
      errorSignature: "prisma p2002 unique constraint failed email",
      confidence: 0.91,
      sourceCount: 5,
      createdAt: daysAgo(48),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ep-03",
      type: "error_pattern",
      title: "SQLITE_BUSY database locked WAL mode concurrent writers",
      content:
        "SQLITE_BUSY: database is locked. Occurs in WAL mode when multiple concurrent writers " +
        "try to acquire the write lock simultaneously. " +
        "Fix: use serialised write queue, enable WAL mode, set busy_timeout pragma to 5000ms. " +
        "In Bun: db.run('PRAGMA busy_timeout = 5000'). Do not open multiple Database instances to the same file.",
      files: ["src/store/database.ts"],
      tags: ["sqlite", "busy", "wal", "locked", "concurrent"],
      errorSignature: "sqlite_busy database locked wal",
      confidence: 0.89,
      sourceCount: 4,
      createdAt: daysAgo(42),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "ep-04",
      type: "error_pattern",
      title: "Stripe webhook signature verification failed invalid raw body",
      content:
        "Stripe webhook signature verification fails when the request body has been parsed by " +
        "a JSON body parser before reaching the webhook handler. " +
        "Error: No signatures found matching the expected signature for payload. " +
        "Fix: use express.raw() middleware for the Stripe webhook route to preserve the raw body buffer. " +
        "Do not apply express.json() globally before stripe webhook routes.",
      files: ["src/webhooks/stripe.ts"],
      tags: ["stripe", "webhook", "signature", "raw", "body"],
      errorSignature: "stripe webhook signature verification failed raw body",
      confidence: 0.95,
      sourceCount: 6,
      createdAt: daysAgo(37),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-05",
      type: "error_pattern",
      title: "TypeError Cannot read properties undefined reading user id",
      content:
        "TypeError: Cannot read properties of undefined (reading 'id'). " +
        "Most commonly occurs when accessing req.user.id before auth middleware runs, " +
        "or when a database query returns null but the code assumes a record exists. " +
        "Fix: always validate that req.user exists before reading properties. " +
        "Use optional chaining req.user?.id and add null checks after database queries.",
      files: ["src/auth/middleware.ts", "src/api/users.ts"],
      tags: ["typescript", "undefined", "null", "typeerror", "user"],
      errorSignature: "typeerror cannot read properties undefined reading id",
      confidence: 0.87,
      sourceCount: 9,
      createdAt: daysAgo(33),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-06",
      type: "error_pattern",
      title: "JWT token expired verification failed middleware",
      content:
        "JsonWebTokenError: jwt expired. Authentication middleware rejects expired tokens. " +
        "Error occurs when the token TTL has passed and the client has not refreshed. " +
        "Fix: catch TokenExpiredError separately from JsonWebTokenError. " +
        "Return 401 with { code: 'TOKEN_EXPIRED' } so clients can distinguish expiry from invalid tokens. " +
        "Set access token TTL to 15 minutes, refresh token to 7 days.",
      files: ["src/auth/middleware.ts", "src/auth/jwt.ts"],
      tags: ["jwt", "token", "expired", "authentication", "middleware"],
      errorSignature: "jsonwebtokenerror jwt expired verification failed",
      confidence: 0.92,
      sourceCount: 5,
      createdAt: daysAgo(29),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ep-07",
      type: "error_pattern",
      title: "CORS preflight OPTIONS request blocked missing origin header",
      content:
        "Access to fetch from origin 'http://localhost:3000' has been blocked by CORS policy: " +
        "Response to preflight request does not pass access control check. " +
        "Occurs when the CORS middleware is not applied before the route handlers, " +
        "or when the allowed origins list does not include the client origin. " +
        "Fix: apply cors() middleware at the top of the Express app, configure allowedOrigins from env.",
      files: ["src/api/server.ts"],
      tags: ["cors", "preflight", "options", "origin", "middleware"],
      errorSignature: "cors preflight options blocked origin header",
      confidence: 0.88,
      sourceCount: 4,
      createdAt: daysAgo(25),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "ep-08",
      type: "error_pattern",
      title: "Cannot find module utils missing extension ESM import resolution",
      content:
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './utils'. " +
        "In ESM (type: module) all relative imports must include the file extension: './utils.js'. " +
        "TypeScript compiles .ts to .js but the import path must reference .js not .ts. " +
        "Fix: always write import paths with .js extension in TypeScript ESM projects. " +
        "Configure moduleResolution: NodeNext in tsconfig.json.",
      files: ["src/utils/logger.ts", "src/compiler/extract.ts"],
      tags: ["esm", "module", "import", "extension", "typescript", "nodejs"],
      errorSignature: "err_module_not_found cannot find module extension esm",
      confidence: 0.94,
      sourceCount: 8,
      createdAt: daysAgo(22),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-09",
      type: "error_pattern",
      title: "Redis connection timeout EHOSTUNREACH cache unavailable",
      content:
        "Redis connection timeout: connect EHOSTUNREACH. Cache layer unavailable. " +
        "Occurs when REDIS_URL points to a host that is not reachable from the application server. " +
        "Fix: implement circuit breaker pattern around cache calls. " +
        "Cache misses should degrade gracefully to the database — never crash the request. " +
        "Use ioredis with reconnectOnError and maxRetriesPerRequest=3.",
      files: ["src/cache/redis.ts"],
      tags: ["redis", "cache", "timeout", "ehostunreach", "circuit-breaker"],
      errorSignature: "redis connection timeout ehostunreach cache",
      confidence: 0.86,
      sourceCount: 3,
      createdAt: daysAgo(19),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "ep-10",
      type: "error_pattern",
      title: "Bun test async open handles leak timeout after test suite",
      content:
        "Bun test runner prints 'open handles prevented exit' after test suite. " +
        "Caused by database connections, HTTP servers, or timers not closed in afterAll. " +
        "Fix: always close database in afterAll(() => db.close()), " +
        "close HTTP servers with server.stop(), clear intervals with clearInterval. " +
        "Bun test runs suites in parallel by default — leaking handles causes flaky failures.",
      files: ["tests/store/database.test.ts"],
      tags: ["bun", "test", "handles", "leak", "timeout", "async"],
      errorSignature: "bun test open handles prevented exit timeout",
      confidence: 0.90,
      sourceCount: 4,
      createdAt: daysAgo(17),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ep-11",
      type: "error_pattern",
      title: "Zod ZodError validation failed missing required field",
      content:
        "ZodError: Required at path 'body.email'. " +
        "Thrown when request body does not contain a field marked z.string() without .optional(). " +
        "Fix: return HTTP 422 with formatted Zod error messages using z.ZodError.flatten(). " +
        "Never pass raw ZodError to the client. Map to { field, message } objects.",
      files: ["src/api/users.ts", "src/utils/validate.ts"],
      tags: ["zod", "validation", "error", "required", "schema"],
      errorSignature: "zoderror required path validation failed",
      confidence: 0.91,
      sourceCount: 6,
      createdAt: daysAgo(15),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-12",
      type: "error_pattern",
      title: "Prisma migration failed target database out of sync shadow",
      content:
        "Error: P3005 The database schema is not empty. Migration fails when the target database " +
        "already has tables that conflict with Prisma's expected baseline. " +
        "Fix: run 'prisma migrate resolve --applied' to mark existing migrations as applied without executing them. " +
        "In CI use 'prisma migrate deploy' not 'prisma migrate dev' to avoid shadow database creation.",
      files: ["src/db/prisma.ts"],
      tags: ["prisma", "migration", "database", "schema", "p3005"],
      errorSignature: "prisma p3005 migration database schema empty",
      confidence: 0.85,
      sourceCount: 3,
      createdAt: daysAgo(13),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "ep-13",
      type: "error_pattern",
      title: "Express rate limit exceeded 429 Too Many Requests headers",
      content:
        "HTTP 429 Too Many Requests from express-rate-limit. " +
        "Client is sending more requests than the configured window allows. " +
        "Ensure the rate limiter sends Retry-After header so clients can back off. " +
        "Use separate rate limit tiers for authenticated vs anonymous users. " +
        "Never share rate limit counters across unrelated endpoints.",
      files: ["src/api/server.ts", "src/api/middleware.ts"],
      tags: ["rate-limit", "express", "429", "too-many-requests"],
      errorSignature: "http 429 too many requests rate limit exceeded",
      confidence: 0.84,
      sourceCount: 3,
      createdAt: daysAgo(11),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ep-14",
      type: "error_pattern",
      title: "FTS5 syntax error near query MATCH malformed FTS expression",
      content:
        "SQLite FTS5 query syntax error: fts5: syntax error near malformed. " +
        "Occurs when user-supplied text contains FTS5 operator characters: *, (, ), \", -. " +
        "Fix: sanitise all FTS5 queries before passing to MATCH clause. " +
        "Replace special characters with spaces. Use escapeFts5() utility function. " +
        "Never pass raw user input directly to FTS5 MATCH.",
      files: ["src/store/search.ts"],
      tags: ["fts5", "sqlite", "query", "syntax", "escape"],
      errorSignature: "fts5 syntax error near match malformed query",
      confidence: 0.93,
      sourceCount: 5,
      createdAt: daysAgo(10),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-15",
      type: "error_pattern",
      title: "TypeScript strict null check failed potential undefined access",
      content:
        "TypeScript error TS2532: Object is possibly undefined. " +
        "Strict null checks enabled in tsconfig.json catch these at compile time. " +
        "Fix: use optional chaining obj?.property, nullish coalescing obj ?? default, " +
        "or explicit if-check before access. Never use non-null assertion ! unless you are certain. " +
        "Prefer refactoring to eliminate the possibility of undefined.",
      files: ["src/compiler/extract.ts", "src/utils/errors.ts"],
      tags: ["typescript", "strict", "null", "undefined", "ts2532"],
      errorSignature: "ts2532 object possibly undefined strict null check",
      confidence: 0.90,
      sourceCount: 7,
      createdAt: daysAgo(9),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-16",
      type: "error_pattern",
      title: "unhandledRejection Promise rejected without catch async await",
      content:
        "UnhandledPromiseRejectionWarning: Promise was rejected but no handler attached. " +
        "Occurs in fire-and-forget async calls that are not awaited. " +
        "Fix: always await async operations or attach .catch() handler. " +
        "Add process.on('unhandledRejection') to log and exit gracefully. " +
        "Avoid void operator to suppress warnings — fix the underlying missing handler.",
      files: ["src/mcp/server.ts", "src/capture/git-hook.ts"],
      tags: ["promise", "async", "rejection", "unhandled", "nodejs"],
      errorSignature: "unhandledrejection promise rejected without catch",
      confidence: 0.88,
      sourceCount: 4,
      createdAt: daysAgo(8),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-17",
      type: "error_pattern",
      title: "Prisma connection pool timeout database query exceeded limit",
      content:
        "Prisma error: Timed out fetching a new connection from the connection pool. " +
        "All connections in the pool are in use. Connection pool size exceeded. " +
        "Fix: increase connection pool size via DATABASE_URL ?connection_limit=20 " +
        "or reduce connection hold time by avoiding long-running transactions. " +
        "Do not instantiate multiple PrismaClient instances — use a singleton.",
      files: ["src/db/prisma.ts"],
      tags: ["prisma", "connection", "pool", "timeout", "database"],
      errorSignature: "prisma connection pool timeout limit exceeded",
      confidence: 0.87,
      sourceCount: 4,
      createdAt: daysAgo(7),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-18",
      type: "error_pattern",
      title: "bcrypt hash comparison failed wrong salt rounds password check",
      content:
        "bcryptjs compare() returns false even with the correct password. " +
        "Caused by comparing plaintext against a hash created with a different salt rounds value " +
        "or comparing against a re-hashed password from a different bcrypt implementation. " +
        "Fix: always use bcrypt.compare(plaintext, storedHash) — never hash before comparing. " +
        "Store the full bcrypt hash including the salt prefix.",
      files: ["src/auth/password.ts"],
      tags: ["bcrypt", "password", "hash", "authentication", "salt"],
      errorSignature: "bcrypt hash comparison failed salt rounds password",
      confidence: 0.86,
      sourceCount: 3,
      createdAt: daysAgo(6),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ep-19",
      type: "error_pattern",
      title: "Docker container OOM killed node process memory limit exceeded",
      content:
        "Container killed with exit code 137 (OOM). Node.js process exceeded container memory limit. " +
        "Common cause: unbounded in-memory cache, large JSON parsing, or memory leak in event listeners. " +
        "Fix: set --max-old-space-size flag in NODE_OPTIONS, add memory monitoring, " +
        "implement LRU eviction for caches. Profile heap with --heapdump flag.",
      files: ["src/cache/redis.ts", "src/utils/logger.ts"],
      tags: ["docker", "oom", "memory", "nodejs", "container"],
      errorSignature: "oom killed node process memory limit exceeded",
      confidence: 0.82,
      sourceCount: 2,
      createdAt: daysAgo(5),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ep-20",
      type: "error_pattern",
      title: "Bun cannot resolve import path tsconfig paths alias",
      content:
        "Bun cannot resolve module '@/components/Button'. Path aliases defined in tsconfig.json " +
        "paths are NOT automatically respected by Bun's runtime — only by the TypeScript compiler. " +
        "Fix: configure bunfig.toml with [target] or use Bun's built-in alias configuration. " +
        "Alternatively restructure imports to use relative paths and avoid aliases.",
      files: ["src/utils/config.ts"],
      tags: ["bun", "import", "alias", "tsconfig", "resolve"],
      errorSignature: "bun cannot resolve import path alias tsconfig",
      confidence: 0.85,
      sourceCount: 3,
      createdAt: daysAgo(4),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-21",
      type: "error_pattern",
      title: "express body parser JSON SyntaxError unexpected token request body",
      content:
        "SyntaxError: Unexpected token in JSON at position 0. " +
        "Request body sent with Content-Type: application/json but body is not valid JSON. " +
        "Common causes: client sending empty body, body already consumed by earlier middleware, " +
        "or using form-encoded body with JSON parser. " +
        "Fix: validate Content-Type header before parsing. Return 400 Bad Request with clear message.",
      files: ["src/api/server.ts"],
      tags: ["express", "json", "body-parser", "syntax", "request"],
      errorSignature: "syntaxerror unexpected token json body parser request",
      confidence: 0.83,
      sourceCount: 3,
      createdAt: daysAgo(4),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-22",
      type: "error_pattern",
      title: "Node ETIMEDOUT external API fetch request timeout exceeded",
      content:
        "FetchError: network timeout at ETIMEDOUT. External API call exceeded the configured timeout. " +
        "Always set an AbortController timeout on external fetch calls. " +
        "const controller = new AbortController(); setTimeout(() => controller.abort(), 5000). " +
        "Log the failing URL and timeout duration for debugging. Implement retry with exponential backoff.",
      files: ["src/api/external.ts", "src/utils/fetch.ts"],
      tags: ["fetch", "timeout", "etimedout", "external", "api"],
      errorSignature: "fetcherror network timeout etimedout external api",
      confidence: 0.84,
      sourceCount: 3,
      createdAt: daysAgo(3),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-23",
      type: "error_pattern",
      title: "Multer file upload LIMIT_FILE_SIZE exceeded multipart form",
      content:
        "MulterError: LIMIT_FILE_SIZE. File upload exceeds the configured size limit. " +
        "Multer rejects the request before the route handler runs. " +
        "Fix: catch MulterError specifically in Express error handler. " +
        "Return HTTP 413 Payload Too Large with human-readable size limit. " +
        "Configure limits.fileSize in bytes: 5 * 1024 * 1024 for 5MB.",
      files: ["src/api/upload.ts"],
      tags: ["multer", "upload", "file", "size", "limit"],
      errorSignature: "multer limit_file_size exceeded multipart upload",
      confidence: 0.80,
      sourceCount: 2,
      createdAt: daysAgo(2),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-24",
      type: "error_pattern",
      title: "Prisma P1001 database server unreachable cannot connect host",
      content:
        "PrismaClientInitializationError: Can't reach database server at host. " +
        "DATABASE_URL is set but the host is unreachable from the current network. " +
        "Occurs in Docker Compose when service names do not resolve, " +
        "or when DATABASE_URL uses localhost but the database is in another container. " +
        "Fix: use the Docker Compose service name as the hostname, not localhost.",
      files: ["src/db/prisma.ts"],
      tags: ["prisma", "database", "unreachable", "host", "p1001", "docker"],
      errorSignature: "prisma p1001 database server unreachable cannot connect",
      confidence: 0.88,
      sourceCount: 4,
      createdAt: daysAgo(2),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-25",
      type: "error_pattern",
      title: "WebSocket connection closed code 1006 abnormal closure keepalive",
      content:
        "WebSocket connection closed with code 1006 (abnormal closure). " +
        "Connection dropped without a proper close frame. " +
        "Cause: missing keepalive ping, proxy timeout (typically 60s on most load balancers), " +
        "or client navigating away. " +
        "Fix: send WebSocket ping every 30s, implement client-side reconnect with exponential backoff. " +
        "Log the close event with code and reason for debugging.",
      files: ["src/api/websocket.ts"],
      tags: ["websocket", "connection", "closed", "keepalive", "1006"],
      errorSignature: "websocket connection closed code 1006 abnormal closure",
      confidence: 0.79,
      sourceCount: 2,
      createdAt: daysAgo(2),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "ep-26",
      type: "error_pattern",
      title: "Bun file system ENOENT no such file or directory path resolution",
      content:
        "Error: ENOENT: no such file or directory. File path does not exist at runtime. " +
        "Common in Bun when using import.meta.dir vs process.cwd() inconsistently. " +
        "Fix: use import.meta.dir for paths relative to the source file. " +
        "Use process.cwd() for paths relative to the working directory at execution time. " +
        "Never concatenate paths with string — use path.join() or path.resolve().",
      files: ["src/utils/config.ts", "src/capture/git-hook.ts"],
      tags: ["bun", "enoent", "filesystem", "path", "resolution"],
      errorSignature: "enoent no such file directory bun path resolution",
      confidence: 0.87,
      sourceCount: 4,
      createdAt: daysAgo(1),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "ep-27",
      type: "error_pattern",
      title: "Express session cookie not persisting SameSite Secure flag HTTPS",
      content:
        "Session cookie not sent by browser after login. " +
        "Caused by SameSite=None without Secure flag on HTTP connections, " +
        "or SameSite=Strict blocking cross-origin requests. " +
        "Fix: set SameSite=Lax for same-origin, SameSite=None; Secure for cross-origin. " +
        "Ensure proxy trusts x-forwarded-proto so Express sees HTTPS.",
      files: ["src/auth/session.ts"],
      tags: ["cookie", "session", "samesite", "secure", "https"],
      errorSignature: "session cookie not persisting samesite secure https",
      confidence: 0.81,
      sourceCount: 3,
      createdAt: daysAgo(1),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "ep-28",
      type: "error_pattern",
      title: "Bun SQLite integer overflow binding large number parameter",
      content:
        "SQLite integer binding overflow: number exceeds 32-bit signed integer range. " +
        "JavaScript number type can represent integers up to 2^53 but SQLite INTEGER is 64-bit. " +
        "Bun's sqlite binding maps large JS numbers incorrectly when they exceed 2^31. " +
        "Fix: use BigInt for large integer values, or store as TEXT and parse at application layer. " +
        "Avoid using Date.now() as a SQLite INTEGER column value.",
      files: ["src/store/database.ts"],
      tags: ["sqlite", "integer", "overflow", "bun", "bigint"],
      errorSignature: "sqlite integer overflow binding large number bun",
      confidence: 0.82,
      sourceCount: 2,
      createdAt: daysAgo(1),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "ep-29",
      type: "error_pattern",
      title: "MCP stdio transport broken pipe EPIPE server process crashed",
      content:
        "EPIPE: broken pipe when writing to stdio. MCP server process has exited. " +
        "Claude Code loses connection to the MCP server, causing all tool calls to fail. " +
        "Fix: add process.on('uncaughtException') and process.on('unhandledRejection') " +
        "to prevent the MCP server from crashing silently. " +
        "Log fatal errors to stderr before exiting so Claude Code can diagnose the crash.",
      files: ["src/mcp/server.ts"],
      tags: ["mcp", "stdio", "epipe", "broken-pipe", "process"],
      errorSignature: "epipe broken pipe stdio mcp server process crashed",
      confidence: 0.90,
      sourceCount: 5,
      createdAt: daysAgo(1),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "ep-30",
      type: "error_pattern",
      title: "GraphQL N plus one query problem resolver Prisma performance",
      content:
        "GraphQL resolver executing N+1 database queries. " +
        "Each parent resolver triggers one query per child item. " +
        "Example: fetching 100 users triggers 100 separate post queries. " +
        "Fix: use DataLoader to batch and deduplicate queries within a single request. " +
        "Use Prisma findMany with include instead of nested resolvers where possible.",
      files: ["src/api/graphql.ts", "src/db/prisma.ts"],
      tags: ["graphql", "n+1", "performance", "dataloader", "prisma"],
      errorSignature: "graphql n1 query resolver prisma performance",
      confidence: 0.83,
      sourceCount: 3,
      createdAt: daysAgo(1),
      lastConfirmed: daysAgo(0),
    },

    // -------------------------------------------------------------------------
    // CONVENTIONS (25 entries)
    // -------------------------------------------------------------------------
    {
      id: "cv-01",
      type: "convention",
      title: "Always use async await never callbacks in new code",
      content:
        "All asynchronous operations must use async/await syntax. " +
        "Callbacks are forbidden in new code because they create callback pyramid and make error handling difficult. " +
        "Wrap callback-based APIs with promisify or util.promisify before use. " +
        "This convention applies to all modules: API handlers, database calls, file operations.",
      files: ["src/api/users.ts", "src/store/database.ts"],
      tags: ["async", "await", "promise", "callback", "convention"],
      confidence: 0.98,
      sourceCount: 12,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-02",
      type: "convention",
      title: "Validate request body with zod schema at api boundary",
      content:
        "Every API route handler must validate the request body using a Zod schema " +
        "before passing data to business logic or the database. " +
        "Define the schema adjacent to the route handler. " +
        "Return HTTP 422 with Zod error details on validation failure. " +
        "Never pass unvalidated input to Prisma or any downstream system.",
      files: ["src/api/users.ts", "src/api/server.ts"],
      tags: ["zod", "validation", "api", "boundary", "schema"],
      confidence: 0.97,
      sourceCount: 10,
      createdAt: daysAgo(59),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-03",
      type: "convention",
      title: "Use Prisma transaction for multi table writes atomicity",
      content:
        "Any operation that writes to multiple tables must be wrapped in a Prisma transaction. " +
        "Use prisma.$transaction([...operations]) for independent queries " +
        "or prisma.$transaction(async (tx) => { ... }) for sequential dependent writes. " +
        "Never rely on application-level rollback logic — use database transactions.",
      files: ["src/db/prisma.ts", "src/api/users.ts"],
      tags: ["prisma", "transaction", "atomic", "database", "multi-table"],
      confidence: 0.96,
      sourceCount: 8,
      createdAt: daysAgo(58),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-04",
      type: "convention",
      title: "Return Result type not throw exception from business logic functions",
      content:
        "Business logic functions must return a discriminated union Result type " +
        "instead of throwing exceptions. Define: type Result<T> = { ok: true; value: T } | { ok: false; error: string }. " +
        "Reserve exceptions for truly unexpected errors (programmer errors, system failures). " +
        "This enables callers to handle all outcomes explicitly without try-catch at every call site.",
      files: ["src/compiler/extract.ts", "src/utils/errors.ts"],
      tags: ["result", "error-handling", "typescript", "union", "functional"],
      confidence: 0.95,
      sourceCount: 7,
      createdAt: daysAgo(57),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-05",
      type: "convention",
      title: "Use satisfies operator for typed config objects TypeScript",
      content:
        "Use the TypeScript satisfies operator for configuration objects to get " +
        "both type checking and type inference. " +
        "const config = { port: 3000, host: 'localhost' } satisfies ServerConfig. " +
        "This preserves the literal types while validating against the interface, " +
        "unlike type annotation which widens literal types.",
      files: ["src/utils/config.ts"],
      tags: ["typescript", "satisfies", "config", "types", "inference"],
      confidence: 0.88,
      sourceCount: 4,
      createdAt: daysAgo(55),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "cv-06",
      type: "convention",
      title: "Rate limit all api routes using express rate limit middleware",
      content:
        "All API routes must be protected by rate limiting. " +
        "Use express-rate-limit with windowMs: 15 * 60 * 1000 and max: 100 for default endpoints. " +
        "Use stricter limits (max: 10) for authentication endpoints to prevent brute force. " +
        "Store rate limit state in Redis for multi-instance deployments, not in-process memory.",
      files: ["src/api/server.ts", "src/api/middleware.ts"],
      tags: ["rate-limit", "api", "security", "middleware", "express"],
      confidence: 0.93,
      sourceCount: 6,
      createdAt: daysAgo(53),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "cv-07",
      type: "convention",
      title: "Never return raw Prisma errors to client sanitize database errors",
      content:
        "Raw Prisma errors expose database schema, table names, and constraint names to clients. " +
        "Always catch Prisma errors and map them to safe HTTP responses. " +
        "PrismaClientKnownRequestError P2002 → 409 Conflict. " +
        "PrismaClientInitializationError → 503 Service Unavailable. " +
        "PrismaClientValidationError → 422 Unprocessable Entity. " +
        "Log the full Prisma error server-side for debugging.",
      files: ["src/db/prisma.ts", "src/api/middleware.ts"],
      tags: ["prisma", "error", "security", "sanitize", "http"],
      confidence: 0.97,
      sourceCount: 9,
      createdAt: daysAgo(51),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "cv-08",
      type: "convention",
      title: "Use structured logging with logger utility never console log",
      content:
        "All log statements must use src/utils/logger.ts — never console.log or console.error directly. " +
        "Logger outputs JSON in production and pretty-prints in development. " +
        "Always include context object: logger.info('message', { userId, requestId }). " +
        "Use appropriate severity levels: debug for trace, info for events, warn for degraded, error for failures.",
      files: ["src/utils/logger.ts"],
      tags: ["logging", "logger", "structured", "json", "convention"],
      confidence: 0.99,
      sourceCount: 15,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-09",
      type: "convention",
      title: "Immutable updates use spread operator never mutate objects",
      content:
        "Never mutate objects or arrays in place. " +
        "Use spread operator { ...obj, field: newValue } for object updates. " +
        "Use [...arr, newItem] or arr.filter() for array updates. " +
        "This applies to all layers: API handlers, database result processing, state management. " +
        "Immutability prevents hidden side effects and makes debugging easier.",
      files: ["src/compiler/extract.ts", "src/compiler/normalize.ts"],
      tags: ["immutability", "spread", "typescript", "functional", "mutation"],
      confidence: 0.96,
      sourceCount: 8,
      createdAt: daysAgo(59),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-10",
      type: "convention",
      title: "Use environment variable validation at startup with zod",
      content:
        "Validate all required environment variables at application startup using a Zod schema. " +
        "If any required variable is missing, log the error and exit immediately with process.exit(1). " +
        "Do not let the application start in a misconfigured state. " +
        "Example: z.object({ DATABASE_URL: z.string().url(), JWT_SECRET: z.string().min(32) }).parse(process.env).",
      files: ["src/utils/config.ts"],
      tags: ["environment", "validation", "startup", "zod", "config"],
      confidence: 0.95,
      sourceCount: 7,
      createdAt: daysAgo(58),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-11",
      type: "convention",
      title: "Wrap external API calls in try catch with timeout abort controller",
      content:
        "All external HTTP calls must be wrapped in try-catch and include an AbortController timeout. " +
        "Default timeout is 10 seconds for external APIs, 30 seconds for upload endpoints. " +
        "Log the external URL (without query parameters containing secrets) on timeout. " +
        "Never let an external API outage crash the application — return degraded response.",
      files: ["src/api/external.ts", "src/utils/fetch.ts"],
      tags: ["fetch", "external", "timeout", "abort", "try-catch"],
      confidence: 0.92,
      sourceCount: 6,
      createdAt: daysAgo(56),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "cv-12",
      type: "convention",
      title: "Use database transactions for write operations rollback safety",
      content:
        "All write operations that modify more than one row or table must use database transactions. " +
        "In bun:sqlite use db.transaction(() => { ... })() for synchronous writes. " +
        "Transactions guarantee atomicity: either all writes succeed or none do. " +
        "Do not hold transactions open longer than necessary — complete them within milliseconds.",
      files: ["src/store/database.ts"],
      tags: ["transaction", "sqlite", "bun", "atomic", "write"],
      confidence: 0.97,
      sourceCount: 11,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-13",
      type: "convention",
      title: "Sanitize FTS5 queries before passing to MATCH clause search",
      content:
        "All user-supplied text passed to FTS5 MATCH must be sanitised with escapeFts5(). " +
        "Remove special characters: *, (, ), \", -. Replace with spaces. " +
        "Apply codeTokenize() first to split camelCase identifiers into tokens. " +
        "Then apply expandQuery() for synonym expansion. " +
        "Pipeline: raw input → codeTokenize → escapeFts5 → expandQuery → MATCH.",
      files: ["src/store/search.ts"],
      tags: ["fts5", "search", "sanitize", "query", "match"],
      confidence: 0.94,
      sourceCount: 6,
      createdAt: daysAgo(50),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "cv-14",
      type: "convention",
      title: "Use PrismaClient singleton pattern avoid connection pool exhaustion",
      content:
        "Instantiate PrismaClient once and reuse it across the application lifecycle. " +
        "Export a singleton instance from src/db/prisma.ts. " +
        "In development hot-reload environments (Bun watch mode), " +
        "store the instance on globalThis to prevent creating a new pool on every reload. " +
        "Multiple PrismaClient instances exhaust the database connection pool.",
      files: ["src/db/prisma.ts"],
      tags: ["prisma", "singleton", "connection", "pool", "pattern"],
      confidence: 0.94,
      sourceCount: 7,
      createdAt: daysAgo(49),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "cv-15",
      type: "convention",
      title: "Tag every knowledge entry with domain and technology tags",
      content:
        "Every entry inserted into the Gyst knowledge base must include at least two tags: " +
        "one domain tag (e.g. 'database', 'auth', 'api') and one technology tag (e.g. 'prisma', 'redis', 'typescript'). " +
        "Tags drive graph traversal search and help cluster related entries. " +
        "Use lowercase kebab-case for multi-word tags.",
      files: ["src/mcp/tools/learn.ts"],
      tags: ["gyst", "tagging", "knowledge", "convention", "taxonomy"],
      confidence: 0.90,
      sourceCount: 5,
      createdAt: daysAgo(45),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "cv-16",
      type: "convention",
      title: "Use zod parse not safeParse when input must be valid exit on failure",
      content:
        "Use z.schema.parse() when invalid input should immediately stop execution (environment config, startup checks). " +
        "Use z.schema.safeParse() when you want to handle validation errors gracefully (API handlers, user input). " +
        "Never silence ZodError — either re-throw after logging or return a structured error response.",
      files: ["src/utils/validate.ts", "src/utils/config.ts"],
      tags: ["zod", "parse", "safeParse", "validation", "typescript"],
      confidence: 0.89,
      sourceCount: 5,
      createdAt: daysAgo(43),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "cv-17",
      type: "convention",
      title: "Close database connection in afterAll test cleanup bun test",
      content:
        "Every test file that creates a database connection must close it in afterAll. " +
        "Failing to close the connection causes open handle leaks in bun test. " +
        "Pattern: let db: Database; beforeAll(() => { db = initDatabase(':memory:'); }); afterAll(() => db.close()). " +
        "Use ':memory:' for tests — never create file-based databases in tests.",
      files: ["tests/store/database.test.ts"],
      tags: ["bun", "test", "database", "cleanup", "handles"],
      confidence: 0.96,
      sourceCount: 8,
      createdAt: daysAgo(40),
      lastConfirmed: daysAgo(1),
    },
    {
      id: "cv-18",
      type: "convention",
      title: "Use kebab-case for file names PascalCase for classes camelCase for functions",
      content:
        "File naming: kebab-case (query-expansion.ts, git-hook.ts). " +
        "Class naming: PascalCase (DatabaseError, SearchError). " +
        "Function naming: camelCase (searchByBM25, insertEntry). " +
        "Constant naming: SCREAMING_SNAKE_CASE for module-level constants (ONE_DAY_MS). " +
        "Interface naming: PascalCase without I prefix (EntryRow, RankedResult).",
      files: ["src/utils/errors.ts"],
      tags: ["naming", "convention", "typescript", "files", "style"],
      confidence: 0.98,
      sourceCount: 12,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-19",
      type: "convention",
      title: "Confidence scores must be between 0.0 and 1.0 never outside range",
      content:
        "All confidence scores in the knowledge base must be normalised to [0.0, 1.0]. " +
        "Entries with confidence below 0.15 are excluded from recall results. " +
        "Confidence decay is applied per entry type: error_pattern 30 days, learning 60 days, decision 365 days. " +
        "Never store raw BM25 scores as confidence — normalise first.",
      files: ["src/store/confidence.ts"],
      tags: ["confidence", "scoring", "normalisation", "decay", "gyst"],
      confidence: 0.95,
      sourceCount: 7,
      createdAt: daysAgo(38),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "cv-20",
      type: "convention",
      title: "MCP tool responses must stay under 5000 tokens context budget",
      content:
        "Every MCP tool response must respect the 5000 token hard limit. " +
        "Recall responses should return at most 5 entries. " +
        "Truncate long content fields to 500 characters. " +
        "Count tokens using src/utils/tokens.ts before sending. " +
        "If the response would exceed the limit, drop lower-confidence entries first.",
      files: ["src/mcp/tools/recall.ts", "src/utils/tokens.ts"],
      tags: ["mcp", "tokens", "context", "limit", "recall"],
      confidence: 0.93,
      sourceCount: 6,
      createdAt: daysAgo(35),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "cv-21",
      type: "convention",
      title: "Strip sensitive data from content before storing in knowledge base",
      content:
        "Run security.ts stripSensitiveData() on all entry content before insertion. " +
        "Patterns to strip: API keys (sk-..., pk_...), JWT tokens (eyJ...), passwords, " +
        "connection strings (postgresql://user:pass@host), IP addresses in logs. " +
        "Replace with placeholder tokens: <API_KEY>, <JWT>, <PASSWORD>. " +
        "Log a warning when stripping occurs — never silently drop content.",
      files: ["src/compiler/security.ts", "src/mcp/tools/learn.ts"],
      tags: ["security", "sensitive", "strip", "api-key", "storage"],
      confidence: 0.99,
      sourceCount: 14,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "cv-22",
      type: "convention",
      title: "Use reciprocal rank fusion k equals 60 for hybrid search results",
      content:
        "When fusing multiple ranked result lists, always use Reciprocal Rank Fusion " +
        "with the standard k=60 smoothing constant from the 2009 Cormack paper. " +
        "Do not change k without benchmarking against the retrieval quality suite. " +
        "RRF(k=60) formula: sum of 1/(60 + rank) across all lists per document.",
      files: ["src/store/search.ts"],
      tags: ["rrf", "search", "fusion", "ranking", "hybrid"],
      confidence: 0.91,
      sourceCount: 5,
      createdAt: daysAgo(30),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "cv-23",
      type: "convention",
      title: "Write JSDoc comment for every exported function with what and why",
      content:
        "Every exported function must have a JSDoc comment explaining what the function does " +
        "and why it exists (the design rationale). " +
        "Include @param and @returns tags for non-trivial signatures. " +
        "Include @throws for functions that throw typed errors. " +
        "Do not write JSDoc for internal implementation details — only exported public API.",
      files: ["src/store/search.ts", "src/store/database.ts"],
      tags: ["jsdoc", "documentation", "convention", "typescript", "exports"],
      confidence: 0.90,
      sourceCount: 6,
      createdAt: daysAgo(28),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "cv-24",
      type: "convention",
      title: "Use type imports for TypeScript only types avoid runtime overhead",
      content:
        "Import TypeScript type-only symbols using 'import type' syntax. " +
        "This ensures type imports are erased at compile time and never included in the runtime bundle. " +
        "import type { EntryRow } from '../store/database.js'. " +
        "Use regular imports only for values (functions, classes, constants) that are used at runtime.",
      files: ["src/compiler/extract.ts"],
      tags: ["typescript", "import-type", "types", "bundle", "erased"],
      confidence: 0.87,
      sourceCount: 5,
      createdAt: daysAgo(26),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "cv-25",
      type: "convention",
      title: "FTS5 porter stemmer matches stems not prefixes use full words",
      content:
        "FTS5 with porter tokenizer matches on word stems not exact tokens. " +
        "'connection' stems to 'connect' and matches 'connections', 'connected', 'connecting'. " +
        "However abbreviated forms like 'conn' do NOT match 'connection' — use full words. " +
        "Similarly 'auth' does not match 'authentication' — write the full word in queries and entries.",
      files: ["src/store/search.ts"],
      tags: ["fts5", "porter", "stemmer", "search", "tokenizer"],
      confidence: 0.95,
      sourceCount: 7,
      createdAt: daysAgo(20),
      lastConfirmed: daysAgo(2),
    },

    // -------------------------------------------------------------------------
    // DECISIONS (20 entries)
    // -------------------------------------------------------------------------
    {
      id: "dc-01",
      type: "decision",
      title: "Chose Bun over Node for built-in SQLite and native TypeScript runtime",
      content:
        "We chose Bun as the runtime instead of Node.js for three reasons: " +
        "1) bun:sqlite is built into Bun with zero npm dependencies, avoiding better-sqlite3 native compilation. " +
        "2) Bun runs TypeScript natively without ts-node or tsc compilation step in development. " +
        "3) Bun's startup time is 3-5x faster than Node.js which matters for git hook invocations. " +
        "Tradeoff: smaller ecosystem than Node but sufficient for our dependencies.",
      files: ["src/cli/index.ts", "src/mcp/server.ts"],
      tags: ["bun", "nodejs", "runtime", "sqlite", "typescript"],
      confidence: 0.98,
      sourceCount: 3,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-02",
      type: "decision",
      title: "Chose Zod over Yup for better TypeScript type inference schema validation",
      content:
        "We chose Zod instead of Yup for schema validation because Zod provides " +
        "superior TypeScript type inference from schema definitions. " +
        "z.infer<typeof schema> produces exact types automatically. " +
        "Yup requires separate TypeScript interface definitions that can drift from the schema. " +
        "Zod also has a cleaner API and better error messages with .flatten().",
      files: ["src/utils/validate.ts", "src/mcp/tools/learn.ts"],
      tags: ["zod", "yup", "validation", "typescript", "schema"],
      confidence: 0.95,
      sourceCount: 3,
      createdAt: daysAgo(59),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-03",
      type: "decision",
      title: "Chose Prisma over raw SQL for type safety and database migrations",
      content:
        "We chose Prisma ORM instead of raw SQL or knex.js for type-safe database access. " +
        "Prisma generates TypeScript types from the schema, eliminating query result type casting. " +
        "Prisma Migrate provides version-controlled schema migrations. " +
        "Tradeoff: Prisma adds 50ms cold start overhead and cannot express all SQL constructs, " +
        "but these tradeoffs are acceptable for our workload.",
      files: ["src/db/prisma.ts"],
      tags: ["prisma", "sql", "orm", "typescript", "migrations"],
      confidence: 0.93,
      sourceCount: 3,
      createdAt: daysAgo(58),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-04",
      type: "decision",
      title: "Chose JWT over sessions for stateless authentication scalability",
      content:
        "We chose JWT tokens instead of server-side sessions for authentication. " +
        "JWTs are stateless: no session store required, scales horizontally without shared Redis. " +
        "Access token TTL: 15 minutes. Refresh token TTL: 7 days stored in httpOnly cookie. " +
        "Tradeoff: JWTs cannot be invalidated before expiry without a token blacklist. " +
        "We accept this tradeoff because 15-minute expiry limits the blast radius of a stolen token.",
      files: ["src/auth/jwt.ts", "src/auth/middleware.ts"],
      tags: ["jwt", "session", "authentication", "stateless", "token"],
      confidence: 0.92,
      sourceCount: 3,
      createdAt: daysAgo(57),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-05",
      type: "decision",
      title: "Chose SQLite FTS5 over Postgres full text search for local first architecture",
      content:
        "We chose SQLite FTS5 for full-text search instead of PostgreSQL tsvector because " +
        "this project is designed for local-first operation on the developer's machine. " +
        "SQLite requires zero server infrastructure. FTS5 with porter stemmer provides " +
        "adequate recall for our knowledge base size (< 10,000 entries). " +
        "Postgres full-text search will be considered if we scale to team-wide cloud deployments.",
      files: ["src/store/search.ts", "src/store/database.ts"],
      tags: ["sqlite", "fts5", "postgres", "search", "local"],
      confidence: 0.97,
      sourceCount: 3,
      createdAt: daysAgo(56),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-06",
      type: "decision",
      title: "Chose MCP stdio transport over HTTP for Claude Code tool integration",
      content:
        "We chose stdio transport for the MCP server rather than HTTP/SSE because " +
        "Claude Code launches MCP servers as child processes over stdio. " +
        "stdio requires no port allocation and avoids network firewall issues. " +
        "The stdio lifecycle is tied to the Claude Code session, which is the correct unit. " +
        "HTTP transport would require the MCP server to run as a separate daemon process.",
      files: ["src/mcp/server.ts"],
      tags: ["mcp", "stdio", "transport", "claude", "integration"],
      confidence: 0.96,
      sourceCount: 3,
      createdAt: daysAgo(55),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-07",
      type: "decision",
      title: "Chose Reciprocal Rank Fusion over linear interpolation for search fusion",
      content:
        "We chose Reciprocal Rank Fusion (RRF) for fusing BM25, file-path, and graph results " +
        "instead of linear score interpolation. " +
        "RRF is parameter-free after the k constant (we use k=60 from the original paper). " +
        "Linear interpolation requires careful weight tuning that breaks as the corpus evolves. " +
        "RRF naturally normalises heterogeneous score ranges across strategies.",
      files: ["src/store/search.ts"],
      tags: ["rrf", "fusion", "search", "bm25", "ranking"],
      confidence: 0.94,
      sourceCount: 3,
      createdAt: daysAgo(50),
      lastConfirmed: daysAgo(8),
    },
    {
      id: "dc-08",
      type: "decision",
      title: "Chose commander over yargs for CLI argument parsing simplicity",
      content:
        "We chose the commander library over yargs or meow for CLI argument parsing. " +
        "Commander has a simpler API for our needs (setup, recall, add subcommands). " +
        "Yargs has more features (middleware, argv manipulation) that we do not need. " +
        "Commander TypeScript types are bundled — no separate @types package required.",
      files: ["src/cli/index.ts"],
      tags: ["commander", "cli", "yargs", "argument", "parsing"],
      confidence: 0.88,
      sourceCount: 2,
      createdAt: daysAgo(48),
      lastConfirmed: daysAgo(12),
    },
    {
      id: "dc-09",
      type: "decision",
      title: "Chose markdown files as source of truth SQLite as derived index",
      content:
        "Knowledge entries are stored as markdown files in gyst-wiki/. " +
        "SQLite is a derived index that can be rebuilt by re-importing all markdown files. " +
        "This design ensures knowledge is recoverable even if the database is corrupted or deleted. " +
        "The compiler pipeline reads markdown and populates SQLite on every sync. " +
        "Never treat the SQLite database as the authoritative source for entry content.",
      files: ["src/compiler/writer.ts", "src/store/rebuild.ts"],
      tags: ["markdown", "sqlite", "source-of-truth", "rebuild", "architecture"],
      confidence: 0.97,
      sourceCount: 3,
      createdAt: daysAgo(46),
      lastConfirmed: daysAgo(8),
    },
    {
      id: "dc-10",
      type: "decision",
      title: "Chose WAL mode for SQLite concurrent read write performance",
      content:
        "SQLite WAL (Write-Ahead Logging) mode is enabled on every connection. " +
        "WAL allows concurrent readers while a writer is active, unlike the default journal mode. " +
        "This is critical for the MCP server (reads) and git hook (writes) running simultaneously. " +
        "WAL also improves write throughput for sequential inserts. " +
        "We also set synchronous=NORMAL for balance between durability and speed.",
      files: ["src/store/database.ts"],
      tags: ["wal", "sqlite", "concurrent", "journal", "performance"],
      confidence: 0.95,
      sourceCount: 3,
      createdAt: daysAgo(44),
      lastConfirmed: daysAgo(9),
    },
    {
      id: "dc-11",
      type: "decision",
      title: "Chose Bun test runner over Jest and Vitest for native TypeScript support",
      content:
        "We use Bun's built-in test runner (bun test) instead of Jest or Vitest. " +
        "Bun test runs TypeScript natively without babel or ts-jest transformation. " +
        "Test suite startup is under 100ms. " +
        "Bun test runs test files in parallel by default with worker threads. " +
        "The API is Jest-compatible: describe, test, expect, beforeAll, afterAll.",
      files: ["tests/store/database.test.ts"],
      tags: ["bun", "test", "jest", "vitest", "typescript"],
      confidence: 0.93,
      sourceCount: 3,
      createdAt: daysAgo(42),
      lastConfirmed: daysAgo(9),
    },
    {
      id: "dc-12",
      type: "decision",
      title: "Chose Redis ioredis over node-redis for connection management reliability",
      content:
        "We chose ioredis over the official node-redis client for cache layer management. " +
        "ioredis has superior automatic reconnection logic and sentinel support out of the box. " +
        "ioredis handles EHOSTUNREACH and connection pool exhaustion more gracefully. " +
        "The ioredis TypeScript types are well-maintained and match the actual API.",
      files: ["src/cache/redis.ts"],
      tags: ["redis", "ioredis", "node-redis", "connection", "cache"],
      confidence: 0.86,
      sourceCount: 2,
      createdAt: daysAgo(40),
      lastConfirmed: daysAgo(12),
    },
    {
      id: "dc-13",
      type: "decision",
      title: "Chose gray-matter for markdown frontmatter parsing over remark",
      content:
        "We use gray-matter for parsing YAML frontmatter from markdown knowledge files. " +
        "gray-matter is lighter than the full remark/unified pipeline for our use case. " +
        "We only need frontmatter parsing plus the raw content body — no AST transformation. " +
        "gray-matter parses frontmatter in under 1ms per file which is acceptable for batch sync.",
      files: ["src/compiler/extract.ts"],
      tags: ["gray-matter", "markdown", "frontmatter", "yaml", "parsing"],
      confidence: 0.87,
      sourceCount: 2,
      createdAt: daysAgo(38),
      lastConfirmed: daysAgo(12),
    },
    {
      id: "dc-14",
      type: "decision",
      title: "Chose porter stemmer for FTS5 over unicode61 for code identifier matching",
      content:
        "FTS5 is configured with 'tokenize = porter unicode61' to use the Porter stemming algorithm. " +
        "Porter stemming allows 'connection' to match 'connections', 'connected', 'connecting'. " +
        "This is essential for knowledge base recall — developers phrase queries differently from authors. " +
        "unicode61 alone performs no stemming, reducing recall by approximately 20%.",
      files: ["src/store/database.ts", "src/store/search.ts"],
      tags: ["porter", "stemmer", "fts5", "tokenizer", "recall"],
      confidence: 0.94,
      sourceCount: 3,
      createdAt: daysAgo(36),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-15",
      type: "decision",
      title: "Chose simple-git over child process git commands for safety",
      content:
        "We use the simple-git library for all git operations instead of spawning child_process. " +
        "simple-git provides a typed async API that handles edge cases: bare repos, detached HEAD, " +
        "empty commit history, Windows path separators. " +
        "Child process git is error-prone: output parsing, exit codes, stderr vs stdout disambiguation. " +
        "simple-git is the canonical choice for git automation in the Node/Bun ecosystem.",
      files: ["src/capture/git-hook.ts"],
      tags: ["simple-git", "git", "child-process", "automation", "capture"],
      confidence: 0.89,
      sourceCount: 2,
      createdAt: daysAgo(34),
      lastConfirmed: daysAgo(11),
    },
    {
      id: "dc-16",
      type: "decision",
      title: "Chose confidence decay half-lives per entry type to model knowledge staleness",
      content:
        "Different entry types decay at different rates: " +
        "error_pattern: 30 days (bugs get fixed quickly). " +
        "convention: no decay (team style guides are stable). " +
        "decision: 365 days (architectural decisions are long-lived). " +
        "learning: 60 days (insights become stale faster than decisions). " +
        "These half-lives are based on common software team dynamics and can be tuned per team.",
      files: ["src/store/confidence.ts"],
      tags: ["confidence", "decay", "staleness", "half-life", "scoring"],
      confidence: 0.91,
      sourceCount: 3,
      createdAt: daysAgo(32),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-17",
      type: "decision",
      title: "Chose 0.15 confidence threshold for recall exclusion to reduce noise",
      content:
        "Entries with confidence below 0.15 are excluded from recall responses. " +
        "This threshold was chosen empirically: below 0.15, entries are either very old " +
        "(decayed from high initial confidence) or were low-quality at insertion. " +
        "The 0.15 floor reduces noise without excluding valid low-confidence entries that are recent. " +
        "The threshold is a constant in src/store/confidence.ts — adjustable via config.",
      files: ["src/store/confidence.ts"],
      tags: ["confidence", "threshold", "recall", "noise", "filter"],
      confidence: 0.90,
      sourceCount: 3,
      createdAt: daysAgo(30),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-18",
      type: "decision",
      title: "Chose codeTokenize preprocessing for FTS5 to split camelCase identifiers",
      content:
        "Before inserting entries or querying FTS5, all text is processed through codeTokenize(). " +
        "codeTokenize splits camelCase: getUserName → get user name. " +
        "It also splits snake_case: get_user_name → get user name. " +
        "This allows queries like 'get user name' to match entries containing 'getUserName'. " +
        "Without this preprocessing, FTS5 treats the whole identifier as a single unsearchable token.",
      files: ["src/store/search.ts"],
      tags: ["camelcase", "tokenize", "fts5", "preprocessing", "identifier"],
      confidence: 0.93,
      sourceCount: 3,
      createdAt: daysAgo(28),
      lastConfirmed: daysAgo(10),
    },
    {
      id: "dc-19",
      type: "decision",
      title: "Chose Turso for V2 team sync deferred until V1 complete",
      content:
        "Team synchronisation of the knowledge base is deferred to V2. " +
        "V2 will use Turso (libsql) as the cloud-hosted SQLite backend to replicate entries across team members. " +
        "Turso was chosen over Supabase because it maintains SQLite API compatibility, " +
        "allowing the same bun:sqlite queries to work locally and in the cloud with minimal changes.",
      files: ["src/store/sync.ts"],
      tags: ["turso", "sync", "team", "v2", "libsql"],
      confidence: 0.88,
      sourceCount: 2,
      createdAt: daysAgo(25),
      lastConfirmed: daysAgo(12),
    },
    {
      id: "dc-20",
      type: "decision",
      title: "Chose parse-git-diff for commit diff parsing over custom regex patterns",
      content:
        "We use the parse-git-diff library to parse unified diff output from git commits. " +
        "Custom regex for unified diff parsing is fragile: binary files, renamed files, " +
        "context lines, and hunk headers all require special cases. " +
        "parse-git-diff handles all these cases and returns a structured AST. " +
        "This feeds the compiler pipeline which extracts knowledge from changed files.",
      files: ["src/capture/git-hook.ts", "src/compiler/extract.ts"],
      tags: ["git-diff", "parser", "commit", "compiler", "regex"],
      confidence: 0.87,
      sourceCount: 2,
      createdAt: daysAgo(22),
      lastConfirmed: daysAgo(12),
    },

    // -------------------------------------------------------------------------
    // LEARNINGS (15 entries)
    // -------------------------------------------------------------------------
    {
      id: "ln-01",
      type: "learning",
      title: "Learned that FTS5 MATCH requires sanitized query porter stemmer strips punctuation",
      content:
        "FTS5 porter stemmer tokenizer strips all punctuation before stemming. " +
        "This means error signatures containing colons, slashes, and brackets must be " +
        "stripped before insertion into the FTS5 index. " +
        "The error signature 'ECONNREFUSED 127.0.0.1:5432' becomes 'econnrefused 127 0 0 1 5432' after tokenisation. " +
        "This discovery led to the escapeFts5() utility and the error normalisation pipeline.",
      files: ["src/store/search.ts", "src/compiler/normalize.ts"],
      tags: ["fts5", "porter", "stemmer", "sanitize", "learning"],
      confidence: 0.92,
      sourceCount: 4,
      createdAt: daysAgo(55),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "ln-02",
      type: "learning",
      title: "Learned that Bun test runs test files in parallel worker threads by default",
      content:
        "Bun test runs each test file in a separate worker thread concurrently. " +
        "This means test files cannot share global state or database files. " +
        "Each test file must create its own ':memory:' database in beforeAll. " +
        "This caused confusing failures before we understood the isolation model. " +
        "Use --timeout flag for slow integration tests: bun test --timeout 30000.",
      files: ["tests/store/database.test.ts"],
      tags: ["bun", "test", "parallel", "worker", "isolation"],
      confidence: 0.90,
      sourceCount: 3,
      createdAt: daysAgo(50),
      lastConfirmed: daysAgo(7),
    },
    {
      id: "ln-03",
      type: "learning",
      title: "Learned that Prisma $transaction does not support mixing $queryRaw with typed models",
      content:
        "Inside a prisma.$transaction() callback, you cannot mix $queryRaw operations with typed model operations. " +
        "$queryRaw uses a different connection context from the transaction client. " +
        "Fix: use either all-raw SQL or all-typed-model operations within a single transaction. " +
        "Discovered while trying to run an upsert with a custom ON CONFLICT clause.",
      files: ["src/db/prisma.ts"],
      tags: ["prisma", "transaction", "queryRaw", "sql", "learning"],
      confidence: 0.85,
      sourceCount: 2,
      createdAt: daysAgo(45),
      lastConfirmed: daysAgo(8),
    },
    {
      id: "ln-04",
      type: "learning",
      title: "Learned that Stripe webhook events replay when server returns non-2xx status",
      content:
        "Stripe replays webhook events for up to 3 days when the endpoint returns a non-2xx status. " +
        "This means webhook handlers must be idempotent — processing the same event twice must be safe. " +
        "Use event.id as an idempotency key. Check if the event was already processed before acting. " +
        "Always return 200 immediately even if background processing is needed.",
      files: ["src/webhooks/stripe.ts"],
      tags: ["stripe", "webhook", "idempotent", "replay", "learning"],
      confidence: 0.88,
      sourceCount: 3,
      createdAt: daysAgo(40),
      lastConfirmed: daysAgo(8),
    },
    {
      id: "ln-05",
      type: "learning",
      title: "Learned that FTS5 implicit AND semantics require all terms to be present",
      content:
        "FTS5 with space-separated terms uses implicit AND: all terms must be present in the document. " +
        "A query 'redis connection timeout' requires 'redis', 'connection', AND 'timeout' all in the same entry. " +
        "This is why long queries fail to match entries that cover the topic without every word. " +
        "Solution: use OR groups for synonyms via expandQuery() to provide alternative terms.",
      files: ["src/store/search.ts", "src/store/query-expansion.ts"],
      tags: ["fts5", "and", "semantics", "query", "learning"],
      confidence: 0.94,
      sourceCount: 5,
      createdAt: daysAgo(35),
      lastConfirmed: daysAgo(6),
    },
    {
      id: "ln-06",
      type: "learning",
      title: "Learned that Redis SCAN is non-blocking unlike KEYS command",
      content:
        "Redis KEYS command blocks the server during iteration and should never be used in production. " +
        "Use SCAN with a cursor for non-blocking key iteration. " +
        "SCAN guarantees all keys are visited exactly once over the full iteration cycle. " +
        "For cache invalidation patterns, use namespaced keys and SCAN with MATCH pattern.",
      files: ["src/cache/redis.ts"],
      tags: ["redis", "scan", "keys", "blocking", "learning"],
      confidence: 0.87,
      sourceCount: 3,
      createdAt: daysAgo(30),
      lastConfirmed: daysAgo(7),
    },
    {
      id: "ln-07",
      type: "learning",
      title: "Learned that JWT verify throws synchronously not returns null on invalid token",
      content:
        "jsonwebtoken verify() throws an error on invalid tokens — it does not return null or undefined. " +
        "Many developers wrap verify() in try-catch expecting a nullable return, " +
        "but the function signature is synchronous-throwing. " +
        "Always use try-catch around jwt.verify(). " +
        "Distinguish TokenExpiredError from JsonWebTokenError for appropriate HTTP response codes.",
      files: ["src/auth/jwt.ts", "src/auth/middleware.ts"],
      tags: ["jwt", "verify", "throws", "synchronous", "learning"],
      confidence: 0.91,
      sourceCount: 4,
      createdAt: daysAgo(27),
      lastConfirmed: daysAgo(6),
    },
    {
      id: "ln-08",
      type: "learning",
      title: "Learned that Bun SQLite prepared statements are faster for repeated queries",
      content:
        "Bun's bun:sqlite prepared statements provide 2-5x performance improvement for queries " +
        "executed repeatedly (e.g. FTS5 MATCH queries in a benchmark loop). " +
        "db.prepare(sql) compiles the query once; .all(...params) re-executes with new bindings. " +
        "For single-shot queries, db.query() is equivalent and more convenient. " +
        "The search module was refactored to use db.query() which caches the prepared statement.",
      files: ["src/store/search.ts"],
      tags: ["sqlite", "prepared", "statement", "performance", "bun"],
      confidence: 0.89,
      sourceCount: 3,
      createdAt: daysAgo(23),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "ln-09",
      type: "learning",
      title: "Learned that graph traversal search seeds by tag substring matching",
      content:
        "The searchByGraph function finds seed entries by matching the query string as a substring " +
        "against both file paths and tag values. " +
        "This means short query terms like 'redis' will match any tag containing 'redis'. " +
        "The one-hop graph traversal then surfaces related entries that share the same tags. " +
        "Seeds score 2.0 and neighbours score 1.0 before RRF fusion.",
      files: ["src/store/search.ts"],
      tags: ["graph", "search", "tag", "seed", "traversal"],
      confidence: 0.88,
      sourceCount: 3,
      createdAt: daysAgo(20),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "ln-10",
      type: "learning",
      title: "Learned that express json middleware must precede route handlers order matters",
      content:
        "Express middleware is executed in the order it is registered. " +
        "app.use(express.json()) must come before app.use('/api', routes) or body parsing will not work. " +
        "This is a common Express beginner mistake — the route handler sees req.body as undefined. " +
        "Similarly, auth middleware must be registered before protected routes.",
      files: ["src/api/server.ts"],
      tags: ["express", "middleware", "order", "json", "learning"],
      confidence: 0.92,
      sourceCount: 5,
      createdAt: daysAgo(18),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "ln-11",
      type: "learning",
      title: "Learned that Zod discriminated union improves error messages for variant types",
      content:
        "z.discriminatedUnion('type', [...schemas]) produces much clearer error messages " +
        "than z.union([...schemas]) for variant types. " +
        "With discriminated union, Zod narrows to the matching variant before validating, " +
        "so error messages reference the correct schema. " +
        "Use discriminated union whenever a field value determines which schema applies.",
      files: ["src/mcp/tools/learn.ts", "src/utils/validate.ts"],
      tags: ["zod", "discriminated-union", "typescript", "variant", "learning"],
      confidence: 0.86,
      sourceCount: 3,
      createdAt: daysAgo(16),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "ln-12",
      type: "learning",
      title: "Learned that SQLite FTS5 content table requires manual trigger synchronization",
      content:
        "FTS5 content tables do not automatically stay in sync with the backing table. " +
        "INSERT, UPDATE, and DELETE triggers must be created manually on the backing table. " +
        "These triggers insert into the FTS5 virtual table for inserts, " +
        "and use the 'delete' command for deletions and the old rowid for updates. " +
        "If triggers are missing, FTS5 queries return stale or empty results.",
      files: ["src/store/database.ts"],
      tags: ["fts5", "trigger", "content-table", "synchronization", "sqlite"],
      confidence: 0.93,
      sourceCount: 4,
      createdAt: daysAgo(14),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "ln-13",
      type: "learning",
      title: "Learned that bcrypt hash cost factor 12 is appropriate for 2024 hardware",
      content:
        "bcrypt cost factor (salt rounds) of 12 takes approximately 400ms on modern hardware. " +
        "This is the recommended minimum as of 2024 for login flows where 400ms is acceptable. " +
        "For high-traffic endpoints, consider argon2 which can be tuned to use less CPU. " +
        "Never use cost factor below 10 — it makes brute-force attacks feasible with GPUs.",
      files: ["src/auth/password.ts"],
      tags: ["bcrypt", "cost", "hash", "security", "learning"],
      confidence: 0.83,
      sourceCount: 2,
      createdAt: daysAgo(12),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "ln-14",
      type: "learning",
      title: "Learned that MCP tool names must use lowercase hyphen separated format",
      content:
        "MCP tool names registered with the ModelContextProtocol SDK must use " +
        "lowercase hyphen-separated format: 'recall-knowledge', 'learn-from-commit'. " +
        "CamelCase tool names cause registration errors in Claude Code. " +
        "Tool descriptions must be under 1024 characters or they are truncated in the UI. " +
        "Input schema must be valid JSON Schema — use Zod toJsonSchema() for generation.",
      files: ["src/mcp/server.ts", "src/mcp/tools/learn.ts"],
      tags: ["mcp", "tool", "naming", "schema", "learning"],
      confidence: 0.91,
      sourceCount: 4,
      createdAt: daysAgo(10),
      lastConfirmed: daysAgo(2),
    },
    {
      id: "ln-15",
      type: "learning",
      title: "Learned that Reciprocal Rank Fusion tolerates missing entries across result lists",
      content:
        "RRF handles missing entries gracefully: if an entry appears in only one of the three search " +
        "strategies (BM25, file-path, graph), it still accumulates an RRF score from that list. " +
        "Entries appearing in all three lists rank highest because their scores compound. " +
        "An entry ranked #1 in BM25 and #1 in graph scores 1/(61) + 1/(61) = 0.0328, " +
        "which outranks any single-list entry regardless of position.",
      files: ["src/store/search.ts"],
      tags: ["rrf", "fusion", "ranking", "missing", "learning"],
      confidence: 0.90,
      sourceCount: 3,
      createdAt: daysAgo(6),
      lastConfirmed: daysAgo(1),
    },

    // -------------------------------------------------------------------------
    // GHOST KNOWLEDGE (10 entries, confidence=1.0)
    // -------------------------------------------------------------------------
    {
      id: "gk-01",
      type: "ghost_knowledge",
      title: "Production deployments require two senior engineer approvals minimum",
      content:
        "No production deployment may proceed with fewer than two senior engineer approvals. " +
        "This policy applies to all production environments including hotfixes and emergency patches. " +
        "The approval must be recorded in the GitHub pull request before the merge. " +
        "Verbal approvals are not acceptable. This policy was established after a production outage in 2023.",
      files: [],
      tags: ["production", "deployment", "approval", "policy", "senior"],
      confidence: 1.0,
      sourceCount: 5,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "gk-02",
      type: "ghost_knowledge",
      title: "Never commit environment files or secrets to the git repository",
      content:
        "Environment files (.env, .env.local, .env.production) must never be committed to git. " +
        "API keys, database credentials, JWT secrets, and webhook signing secrets must be stored " +
        "in the team password manager and injected via CI/CD environment variables. " +
        ".gitignore must always include .env* patterns. " +
        "If a secret is accidentally committed, rotate it immediately and audit all repositories.",
      files: [],
      tags: ["secrets", "environment", "git", "security", "policy"],
      confidence: 1.0,
      sourceCount: 8,
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(0),
    },
    {
      id: "gk-03",
      type: "ghost_knowledge",
      title: "Database schema changes require a rollback migration plan before deployment",
      content:
        "Every database schema change migration must be accompanied by a rollback migration. " +
        "The rollback migration must be tested in staging before the forward migration is deployed to production. " +
        "Destructive operations (DROP COLUMN, DROP TABLE) must be staged over two releases: " +
        "first mark as deprecated, then remove in the subsequent release after all code is updated.",
      files: [],
      tags: ["database", "migration", "rollback", "schema", "deployment"],
      confidence: 1.0,
      sourceCount: 4,
      createdAt: daysAgo(55),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "gk-04",
      type: "ghost_knowledge",
      title: "On call rotation engineer is the single point of contact for production incidents",
      content:
        "During production incidents, all communication must route through the on-call engineer. " +
        "Other engineers must not make independent changes to production during an active incident. " +
        "The on-call engineer has authority to roll back any deployment without additional approval. " +
        "Incident timeline must be documented in the #incidents Slack channel in real time.",
      files: [],
      tags: ["oncall", "incident", "production", "rotation", "policy"],
      confidence: 1.0,
      sourceCount: 3,
      createdAt: daysAgo(50),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "gk-05",
      type: "ghost_knowledge",
      title: "External API keys must be rotated every 90 days per security policy",
      content:
        "All external API keys including Stripe, OpenAI, Twilio, and AWS credentials " +
        "must be rotated on a 90-day schedule. " +
        "Rotation schedule is tracked in the security team's Notion database. " +
        "Expired keys that are not rotated within 7 days of the deadline trigger an automatic security review. " +
        "Key rotation must be coordinated with zero-downtime deployment.",
      files: [],
      tags: ["api-key", "rotation", "security", "policy", "90-day"],
      confidence: 1.0,
      sourceCount: 4,
      createdAt: daysAgo(45),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "gk-06",
      type: "ghost_knowledge",
      title: "All HTTP endpoints must log request ID for distributed tracing correlation",
      content:
        "Every HTTP request must be assigned a unique request ID (UUID v4) at the ingress. " +
        "The request ID is propagated in the X-Request-ID header to all downstream services. " +
        "All log entries for the request must include the request ID for correlation. " +
        "The request ID must be returned in the response headers for client-side debugging.",
      files: [],
      tags: ["request-id", "tracing", "logging", "http", "correlation"],
      confidence: 1.0,
      sourceCount: 6,
      createdAt: daysAgo(40),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "gk-07",
      type: "ghost_knowledge",
      title: "Code review requires at least one reviewer who understands the changed domain",
      content:
        "Pull requests must have at least one reviewer who has domain expertise in the changed area. " +
        "A generic senior engineer cannot approve changes to the payment processing, " +
        "authentication, or database migration modules without specific expertise. " +
        "Domain expert lists are maintained in CODEOWNERS file in the repository root.",
      files: [],
      tags: ["code-review", "domain", "expertise", "policy", "codeowners"],
      confidence: 1.0,
      sourceCount: 3,
      createdAt: daysAgo(35),
      lastConfirmed: daysAgo(5),
    },
    {
      id: "gk-08",
      type: "ghost_knowledge",
      title: "Stripe webhook secret must be per environment never shared between staging and production",
      content:
        "Stripe provides separate webhook endpoint secrets for each environment. " +
        "The staging webhook secret must never be used in production and vice versa. " +
        "Using the wrong secret causes all webhook signature verifications to fail. " +
        "Each environment registers a separate webhook endpoint URL in the Stripe dashboard. " +
        "Secrets are stored in environment-specific secret stores.",
      files: [],
      tags: ["stripe", "webhook", "secret", "environment", "policy"],
      confidence: 1.0,
      sourceCount: 4,
      createdAt: daysAgo(30),
      lastConfirmed: daysAgo(4),
    },
    {
      id: "gk-09",
      type: "ghost_knowledge",
      title: "Zero downtime deployments require database backward compatibility across two releases",
      content:
        "During a rolling deployment, old and new application versions run simultaneously. " +
        "Database schema changes must be backward compatible: new columns must have defaults, " +
        "removed columns must first be ignored by code before the column is dropped. " +
        "This requires a two-phase deploy: phase 1 adds new schema and updated code, " +
        "phase 2 removes old schema after all instances are on the new code.",
      files: [],
      tags: ["zero-downtime", "deployment", "database", "backward-compatibility", "rolling"],
      confidence: 1.0,
      sourceCount: 5,
      createdAt: daysAgo(25),
      lastConfirmed: daysAgo(3),
    },
    {
      id: "gk-10",
      type: "ghost_knowledge",
      title: "Security vulnerabilities in dependencies must be patched within 72 hours of disclosure",
      content:
        "When a security advisory is published for a direct or transitive dependency, " +
        "the team has 72 hours to assess severity and deploy a patch. " +
        "Critical CVEs (CVSS >= 9.0) must be patched within 24 hours. " +
        "Use Dependabot alerts for automated detection. " +
        "Patch deployment follows the standard zero-downtime deployment process.",
      files: [],
      tags: ["security", "vulnerability", "cve", "patch", "dependabot"],
      confidence: 1.0,
      sourceCount: 4,
      createdAt: daysAgo(20),
      lastConfirmed: daysAgo(3),
    },
  ];

  for (const entry of entries) {
    insertEntry(database, entry);
  }
}

// ---------------------------------------------------------------------------
// Query groups
// ---------------------------------------------------------------------------

/**
 * GROUP 1 — Direct: exact keyword match.
 * All queries use words that appear verbatim in the seeded entry content.
 * Target MRR@5 >= 0.90
 */
const directQueries: Array<{ query: string; relevantIds: string[] }> = [
  {
    query: "stripe webhook signature verification raw body",
    relevantIds: ["ep-04"],
  },
  {
    query: "prisma unique constraint failed email p2002",
    relevantIds: ["ep-02"],
  },
  {
    query: "SQLITE_BUSY database locked WAL mode",
    relevantIds: ["ep-03"],
  },
  {
    query: "JWT token expired verification middleware",
    relevantIds: ["ep-06"],
  },
  {
    query: "fts5 query syntax error malformed sanitise",
    relevantIds: ["ep-14"],
  },
];

/**
 * GROUP 2 — Semantic: related terms that appear in content.
 * Target MRR@5 >= 0.75
 */
const semanticQueries: Array<{ query: string; relevantIds: string[] }> = [
  {
    query: "postgres connection refused port 5432 database",
    relevantIds: ["ep-01"],
  },
  {
    query: "redis cache timeout connection unavailable",
    relevantIds: ["ep-09"],
  },
  {
    query: "bun open handles prevented exit test runner",
    relevantIds: ["ep-10"],
  },
  {
    query: "typescript module not found extension esm import",
    relevantIds: ["ep-08"],
  },
  {
    query: "cors blocked preflight origin header request",
    relevantIds: ["ep-07"],
  },
];

/**
 * GROUP 3 — File-specific: searchByFilePath directly.
 * Target MRR@5 >= 0.85
 */
const fileQueries: Array<{ query: string; relevantIds: string[] }> = [
  {
    query: "src/webhooks/stripe.ts",
    relevantIds: ["ep-04", "ln-04", "gk-08"],
  },
  {
    query: "src/auth/middleware.ts",
    relevantIds: ["ep-05", "ep-06", "dc-04", "ln-07"],
  },
  {
    query: "src/store/search.ts",
    relevantIds: [
      "ep-14",
      "cv-13",
      "cv-22",
      "cv-25",
      "dc-05",
      "dc-07",
      "dc-14",
      "dc-18",
      "ln-15",
      "ln-09",
      "ln-08",
      "ln-05",
    ],
  },
  {
    query: "src/db/prisma.ts",
    relevantIds: ["ep-02", "ep-12", "ep-17", "ep-24", "cv-03", "cv-07", "dc-03", "ln-03"],
  },
  {
    query: "src/cache/redis.ts",
    relevantIds: ["ep-09", "ep-19", "dc-12", "ln-06"],
  },
];

/**
 * GROUP 4 — Team context: conventions and decisions using actual content words.
 * Target MRR@5 >= 0.70
 */
const teamContextQueries: Array<{ query: string; relevantIds: string[] }> = [
  {
    query: "zod validation schema api boundary request",
    relevantIds: ["cv-02"],
  },
  {
    query: "async await promise callback convention",
    relevantIds: ["cv-01"],
  },
  {
    query: "bun sqlite native typescript runtime chose over node",
    relevantIds: ["dc-01"],
  },
  {
    query: "prisma transaction atomic multi table write",
    relevantIds: ["cv-03"],
  },
  {
    query: "logger structured logging json never console log",
    relevantIds: ["cv-08"],
  },
];

/**
 * GROUP 5 — Cross-cutting: spans multiple entry types with shared vocabulary.
 * Target MRR@5 >= 0.55
 */
const crossCuttingQueries: Array<{ query: string; relevantIds: string[] }> = [
  {
    // "pool" and "prisma" and "connection" appear in ep-17, cv-14, dc-03
    query: "prisma connection pool database",
    relevantIds: ["ep-17", "cv-14", "dc-03"],
  },
  {
    // "porter" and "stemmer" appear in dc-14, cv-25, ln-01
    query: "porter stemmer fts5",
    relevantIds: ["cv-25", "dc-14", "ln-01"],
  },
  {
    // "bun" and "test" and "parallel" appear in dc-11, ln-02
    query: "bun test parallel worker",
    relevantIds: ["cv-17", "dc-11", "ln-02"],
  },
  {
    // "stripe" and "webhook" appear in ep-04, ln-04, gk-08
    query: "stripe webhook endpoint",
    relevantIds: ["ep-04", "ln-04", "gk-08"],
  },
  {
    // "wal" and "sqlite" appear in ep-03, dc-10, cv-12
    query: "sqlite wal write concurrent",
    relevantIds: ["ep-03", "cv-12", "dc-10"],
  },
];

/**
 * GROUP 6 — Ghost knowledge entries must surface above noise.
 * Target MRR@5 >= 0.90
 */
const ghostQueries: Array<{ query: string; relevantIds: string[] }> = [
  {
    query: "production deployment approval senior engineer",
    relevantIds: ["gk-01"],
  },
  {
    query: "environment secrets git repository commit",
    relevantIds: ["gk-02"],
  },
  {
    query: "stripe webhook secret environment staging production",
    relevantIds: ["gk-08"],
  },
  {
    query: "security vulnerability cve patch dependabot",
    relevantIds: ["gk-10"],
  },
  {
    query: "request id tracing logging http correlation",
    relevantIds: ["gk-06"],
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CODE Retrieval Quality Benchmark", () => {
  describe("Group 1 — Direct queries (target MRR@5 ≥ 0.90)", () => {
    test("direct query group meets MRR@5 ≥ 0.90", async () => {
      const mrr = await groupMrr(directQueries, (q) => hybridSearch(db, q));
      console.log(`[direct] MRR@5 = ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(0.90);
    });
  });

  describe("Group 2 — Semantic queries (target MRR@5 ≥ 0.75)", () => {
    test("semantic query group meets MRR@5 ≥ 0.75", async () => {
      const mrr = await groupMrr(semanticQueries, (q) => hybridSearch(db, q));
      console.log(`[semantic] MRR@5 = ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(0.75);
    });
  });

  describe("Group 3 — File-specific queries (target MRR@5 ≥ 0.85)", () => {
    test("file-specific query group meets MRR@5 ≥ 0.85", async () => {
      const mrr = await groupMrr(fileQueries, (q) =>
        Promise.resolve(searchByFilePath(db, [q])),
      );
      console.log(`[file-specific] MRR@5 = ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe("Group 4 — Team context queries (target MRR@5 ≥ 0.70)", () => {
    test("team context query group meets MRR@5 ≥ 0.70", async () => {
      const mrr = await groupMrr(teamContextQueries, (q) => hybridSearch(db, q));
      console.log(`[team-context] MRR@5 = ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(0.70);
    });
  });

  describe("Group 5 — Cross-cutting queries (target MRR@5 ≥ 0.55)", () => {
    test("cross-cutting query group meets MRR@5 ≥ 0.55", async () => {
      const mrr = await groupMrr(crossCuttingQueries, (q) => hybridSearch(db, q));
      console.log(`[cross-cutting] MRR@5 = ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(0.55);
    });
  });

  describe("Group 6 — Ghost knowledge queries (target MRR@5 ≥ 0.90)", () => {
    test("ghost knowledge query group meets MRR@5 ≥ 0.90", async () => {
      const mrr = await groupMrr(ghostQueries, (q) => hybridSearch(db, q));
      console.log(`[ghost] MRR@5 = ${mrr.toFixed(4)}`);
      expect(mrr).toBeGreaterThanOrEqual(0.90);
    });
  });

  describe("Overall aggregate (target MRR@5 ≥ 0.75 across all 30 queries)", () => {
    test("overall MRR@5 across all 30 queries meets ≥ 0.75", async () => {
      const allGroups = [
        ...directQueries,
        ...semanticQueries,
        ...teamContextQueries,
        ...crossCuttingQueries,
        ...ghostQueries,
      ];

      // Non-file groups use hybridSearch
      let hybridTotalMrr = 0;
      for (const { query, relevantIds } of allGroups) {
        const results = await hybridSearch(db, query);
        hybridTotalMrr += mrrAtK(results, relevantIds);
      }
      const hybridMrr = hybridTotalMrr / allGroups.length;

      // File group uses searchByFilePath
      const fileMrr = fileQueries.reduce((sum, { query, relevantIds }) => {
        const results = searchByFilePath(db, [query]);
        return sum + mrrAtK(results, relevantIds);
      }, 0) / fileQueries.length;

      // Weighted aggregate: 25 hybrid queries + 5 file queries = 30 total
      const overallMrr = (hybridMrr * allGroups.length + fileMrr * fileQueries.length) / 30;
      console.log(`[overall] hybrid MRR@5 = ${hybridMrr.toFixed(4)}, file MRR@5 = ${fileMrr.toFixed(4)}, overall = ${overallMrr.toFixed(4)}`);
      expect(overallMrr).toBeGreaterThanOrEqual(0.75);
    });
  });
});
