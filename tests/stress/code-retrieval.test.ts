/**
 * Stress test: code-retrieval MRR@5 per category.
 *
 * Seeds 100 diverse entries, then runs 23 labeled queries across four
 * categories (keyword, file-specific, ghost-knowledge, cross-cutting) and
 * asserts Reciprocal Rank Fusion quality thresholds per category and in
 * aggregate. Timing assertions verify the search pipeline is fast enough for
 * interactive use.
 *
 * WHY: MRR@5 is the primary quality metric for Gyst's retrieval pipeline.
 * This harness catches regressions in BM25 tuning, FTS5 tokenisation changes,
 * or RRF weight adjustments before they reach production.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import {
  searchByBM25,
  searchByFilePath,
  searchByGraph,
  reciprocalRankFusion,
} from "../../src/store/search.js";
import type { RankedResult } from "../../src/store/search.js";

// ---------------------------------------------------------------------------
// MRR helpers (inline — no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Computes the reciprocal rank of the first relevant document in a ranked
 * list, capped at rank 5. Returns 0 if no relevant document appears in top 5.
 */
function computeReciprocalRank(
  rankedIds: string[],
  relevantIds: string[],
): number {
  for (let i = 0; i < Math.min(rankedIds.length, 5); i++) {
    if (relevantIds.includes(rankedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Computes Mean Reciprocal Rank over a set of labeled queries.
 */
function computeMRR(
  queries: Array<{ rankedIds: string[]; relevantIds: string[] }>,
): number {
  if (queries.length === 0) return 0;
  const sum = queries.reduce(
    (acc, q) => acc + computeReciprocalRank(q.rankedIds, q.relevantIds),
    0,
  );
  return sum / queries.length;
}

// ---------------------------------------------------------------------------
// Labeled query interface
// ---------------------------------------------------------------------------

interface LabeledQuery {
  readonly query: string;
  readonly relevantIds: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_PATHS = [
  "src/payments/checkout.ts",
  "src/auth/middleware.ts",
  "src/database/connection.ts",
  "src/api/webhooks.ts",
  "src/utils/validation.ts",
] as const;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let db: Database;

// ---------------------------------------------------------------------------
// Global beforeAll — seed 100 entries
// ---------------------------------------------------------------------------

beforeAll(() => {
  db = initDatabase(":memory:");

  // ---- 20 keyword entries (keyword-0 … keyword-19) -----------------------
  // Each has a distinct technical keyword cluster for BM25 recall.

  const keywordEntries: EntryRow[] = [
    {
      id: "keyword-0",
      type: "learning",
      title: "SQLite WAL mode improves concurrent reads",
      content:
        "Enable WAL mode for concurrent reads. Run: PRAGMA journal_mode=WAL",
      files: [],
      tags: ["sqlite", "wal", "concurrency"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-1",
      type: "learning",
      title: "Bun native TypeScript compilation without transpilation",
      content:
        "Bun runs TypeScript natively without tsc. No build step needed.",
      files: [],
      tags: ["bun", "typescript", "compilation"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-2",
      type: "convention",
      title: "FTS5 porter stemmer tokenizes camelCase identifiers",
      content:
        "Use tokenize porter unicode61 in FTS5 for stemming and camelCase support.",
      files: [],
      tags: ["fts5", "porter", "stemmer", "tokenize"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-3",
      type: "error_pattern",
      title: "Zod schema validation rejects malformed payloads at boundary",
      content:
        "Always validate request payloads with Zod schemas at the API boundary. ZodError is thrown on invalid input.",
      files: [],
      tags: ["zod", "validation", "schema"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "zoderror: invalid input at <path>",
    },
    {
      id: "keyword-4",
      type: "learning",
      title: "Reciprocal rank fusion merges heterogeneous result lists",
      content:
        "RRF combines BM25 and file-path ranked lists using the formula 1/(k+rank). k=60 is the standard constant.",
      files: [],
      tags: ["rrf", "fusion", "ranking"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-5",
      type: "convention",
      title: "MCP server uses stdio transport for tool communication",
      content:
        "The MCP server is wired to Claude Code via stdio transport. Never switch to HTTP transport in V1.",
      files: [],
      tags: ["mcp", "stdio", "transport"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-6",
      type: "learning",
      title: "Confidence decay half-life differs by entry type",
      content:
        "error_pattern decays with 30-day half-life. convention never decays. learning decays in 60 days.",
      files: [],
      tags: ["confidence", "decay", "half-life"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-7",
      type: "decision",
      title: "Bun SQLite chosen over better-sqlite3 for zero native deps",
      content:
        "bun:sqlite is bundled with Bun and requires no native compilation. better-sqlite3 needs node-gyp.",
      files: [],
      tags: ["bun", "sqlite", "decision", "native"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-8",
      type: "convention",
      title: "Gray-matter parses YAML frontmatter in markdown files",
      content:
        "Use gray-matter to extract frontmatter from .md knowledge files. The body is the entry content.",
      files: [],
      tags: ["gray-matter", "frontmatter", "markdown"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-9",
      type: "learning",
      title: "Post-commit git hook triggers automatic knowledge capture",
      content:
        "The git post-commit hook calls gyst capture to extract learning from each commit diff automatically.",
      files: [],
      tags: ["git", "hook", "post-commit", "capture"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-10",
      type: "error_pattern",
      title: "FTS5 syntax error on hyphen in MATCH query",
      content:
        "FTS5 raises syntax error when query contains hyphens. Strip hyphens before building MATCH expressions.",
      files: [],
      tags: ["fts5", "syntax", "hyphen", "error"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "fts5: syntax error near <str>",
    },
    {
      id: "keyword-11",
      type: "convention",
      title: "Commander CLI parses subcommands for gyst recall and add",
      content:
        "The CLI is built with commander. Subcommands are recall, add, setup, install-hooks.",
      files: [],
      tags: ["commander", "cli", "subcommand"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-12",
      type: "learning",
      title: "Simple-git wraps Node.js git operations with async API",
      content:
        "simple-git provides promise-based wrappers for git log, diff, and status. Used in the capture pipeline.",
      files: [],
      tags: ["simple-git", "async", "wrapper"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-13",
      type: "convention",
      title: "Parse-git-diff extracts structured hunks from unified diff",
      content:
        "parse-git-diff turns raw unified diff text into structured objects with file, hunk, and line data.",
      files: [],
      tags: ["parse-git-diff", "hunk", "unified-diff"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-14",
      type: "learning",
      title: "Turso team sync deferred to V2 release milestone",
      content:
        "Turso remote replication is a V2 feature. Do not build team sync in the current V1 sprint.",
      files: [],
      tags: ["turso", "sync", "v2", "deferred"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-15",
      type: "convention",
      title: "Error normalization replaces file paths with placeholder token",
      content:
        "Normalise error signatures by replacing file paths with <PATH> before BM25 indexing.",
      files: [],
      tags: ["normalization", "error", "placeholder"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-16",
      type: "learning",
      title: "Logger utility wraps pino for structured JSON log output",
      content:
        "All log output goes through src/utils/logger.ts which wraps pino. Never use console.log directly.",
      files: [],
      tags: ["logger", "pino", "structured"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-17",
      type: "decision",
      title: "Markdown files are source of truth SQLite is derived index",
      content:
        "Markdown files are canonical. SQLite FTS index is rebuilt from markdown if the database is deleted.",
      files: [],
      tags: ["markdown", "source-of-truth", "sqlite", "rebuild"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-18",
      type: "convention",
      title: "Recall response token budget capped at five thousand tokens",
      content:
        "MCP recall responses must never exceed 5000 tokens. Truncate content before serialising to JSON.",
      files: [],
      tags: ["token", "budget", "recall", "truncate"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "keyword-19",
      type: "convention",
      title: "All database writes wrapped in SQLite transactions for atomicity",
      content:
        "Use db.transaction() for every write operation. Partial writes must never leave the database in an inconsistent state.",
      files: [],
      tags: ["transaction", "atomicity", "sqlite", "write"],
      confidence: 0.8,
      sourceCount: 1,
    },
  ];

  for (const entry of keywordEntries) {
    insertEntry(db, entry);
  }

  // ---- 20 file-specific entries (file-0 … file-19) -----------------------
  // 4 entries per file path.

  const fileEntries: EntryRow[] = [
    // src/payments/checkout.ts (file-0..3)
    {
      id: "file-0",
      type: "convention",
      title: "Checkout validates cart total before charge",
      content:
        "Always recompute the cart total server-side before calling the payment processor in checkout.",
      files: ["src/payments/checkout.ts"],
      tags: ["payments", "checkout", "validation"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-1",
      type: "learning",
      title: "Checkout idempotency key prevents duplicate charges",
      content:
        "Pass an idempotency key derived from the order ID to prevent duplicate charges on network retry.",
      files: ["src/payments/checkout.ts"],
      tags: ["payments", "idempotency", "stripe"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-2",
      type: "error_pattern",
      title: "Stripe card declined error handled in checkout flow",
      content:
        "Catch StripeCardError in checkout and return a user-friendly message. Do not expose raw error codes.",
      files: ["src/payments/checkout.ts"],
      tags: ["payments", "stripe", "error"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "stripecardError: your card was declined",
    },
    {
      id: "file-3",
      type: "convention",
      title: "Checkout emits order-created event after successful charge",
      content:
        "After a successful Stripe charge, publish an order-created event to the event bus from checkout.",
      files: ["src/payments/checkout.ts"],
      tags: ["payments", "event", "order"],
      confidence: 0.8,
      sourceCount: 1,
    },
    // src/auth/middleware.ts (file-4..7)
    {
      id: "file-4",
      type: "convention",
      title: "Auth middleware attaches decoded JWT to request context",
      content:
        "The auth middleware verifies the Bearer token and attaches the decoded userId to req.context.",
      files: ["src/auth/middleware.ts"],
      tags: ["auth", "jwt", "middleware"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-5",
      type: "learning",
      title: "Auth middleware short-circuits on missing Authorization header",
      content:
        "Return 401 immediately if the Authorization header is absent. Do not proceed to route handlers.",
      files: ["src/auth/middleware.ts"],
      tags: ["auth", "401", "header"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-6",
      type: "error_pattern",
      title: "JWT signature verification fails on expired token",
      content:
        "JsonWebTokenError is thrown for expired tokens. Catch in auth middleware and return 401 with message.",
      files: ["src/auth/middleware.ts"],
      tags: ["auth", "jwt", "expired"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "jsonwebtokenerror: token expired",
    },
    {
      id: "file-7",
      type: "convention",
      title: "Auth middleware refreshes token before expiry window",
      content:
        "If token expires within 5 minutes, silently issue a refreshed token in the response header.",
      files: ["src/auth/middleware.ts"],
      tags: ["auth", "refresh", "token"],
      confidence: 0.8,
      sourceCount: 1,
    },
    // src/database/connection.ts (file-8..11)
    {
      id: "file-8",
      type: "convention",
      title: "Database connection pool size set to ten for production",
      content:
        "Configure pg connection pool with max=10. More than 10 connections causes resource contention.",
      files: ["src/database/connection.ts"],
      tags: ["database", "pool", "connection"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-9",
      type: "learning",
      title: "Database connection retries with exponential backoff on failure",
      content:
        "Use exponential backoff with jitter when the initial database connection fails at startup.",
      files: ["src/database/connection.ts"],
      tags: ["database", "retry", "backoff"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-10",
      type: "error_pattern",
      title: "Connection timeout triggers on cold container start",
      content:
        "PostgreSQL connection times out when container starts cold. Increase connect_timeout to 30s.",
      files: ["src/database/connection.ts"],
      tags: ["database", "timeout", "container"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "error: connection timed out after <N>ms",
    },
    {
      id: "file-11",
      type: "convention",
      title: "Connection string read from DATABASE_URL environment variable",
      content:
        "Never hardcode the connection string. Read DATABASE_URL from environment and validate at startup.",
      files: ["src/database/connection.ts"],
      tags: ["database", "env", "connection-string"],
      confidence: 0.8,
      sourceCount: 1,
    },
    // src/api/webhooks.ts (file-12..15)
    {
      id: "file-12",
      type: "convention",
      title: "Webhook handler verifies HMAC signature before processing",
      content:
        "Verify the X-Signature header against the raw request body with HMAC-SHA256 before any processing.",
      files: ["src/api/webhooks.ts"],
      tags: ["webhook", "hmac", "signature"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-13",
      type: "learning",
      title: "Webhook endpoint returns 200 immediately to prevent retry storms",
      content:
        "Acknowledge the webhook with 200 before async processing. Long handlers cause retry storms.",
      files: ["src/api/webhooks.ts"],
      tags: ["webhook", "async", "retry"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-14",
      type: "error_pattern",
      title: "Webhook delivery failure logged with full payload for replay",
      content:
        "On processing failure, log the full webhook payload so it can be replayed from the admin panel.",
      files: ["src/api/webhooks.ts"],
      tags: ["webhook", "replay", "failure"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "webhook processing failed: <str>",
    },
    {
      id: "file-15",
      type: "convention",
      title: "Webhook events stored in outbox table for idempotent replay",
      content:
        "Persist webhook events in an outbox table with a processed flag to support safe idempotent replay.",
      files: ["src/api/webhooks.ts"],
      tags: ["webhook", "outbox", "idempotent"],
      confidence: 0.8,
      sourceCount: 1,
    },
    // src/utils/validation.ts (file-16..19)
    {
      id: "file-16",
      type: "convention",
      title: "Validation utility wraps Zod parse with typed error response",
      content:
        "The validation utility calls schema.safeParse and formats ZodError into a structured API error.",
      files: ["src/utils/validation.ts"],
      tags: ["validation", "zod", "utility"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-17",
      type: "learning",
      title: "Validation runs at API boundary before business logic executes",
      content:
        "Call the validation utility as the first step in every route handler before touching business logic.",
      files: ["src/utils/validation.ts"],
      tags: ["validation", "api", "boundary"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-18",
      type: "convention",
      title: "Shared Zod schemas exported from validation utility module",
      content:
        "Define all reusable Zod schemas in src/utils/validation.ts and import them across handlers.",
      files: ["src/utils/validation.ts"],
      tags: ["validation", "schema", "shared"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "file-19",
      type: "error_pattern",
      title: "Validation error surfaces field path in 422 response body",
      content:
        "When Zod validation fails, return HTTP 422 with an errors array that includes each failing field path.",
      files: ["src/utils/validation.ts"],
      tags: ["validation", "422", "field-path"],
      confidence: 0.8,
      sourceCount: 1,
      errorSignature: "validation failed: <path> <str>",
    },
  ];

  for (const entry of fileEntries) {
    insertEntry(db, entry);
  }

  // ---- 20 temporal entries (temporal-0 … temporal-19) -------------------
  // Content intentionally references time so queries can find them.

  const temporalEntries: EntryRow[] = [
    // 5 entries for 1-day bucket (0..4)
    {
      id: "temporal-0",
      type: "learning",
      title: "API rate limit increased this week to 10000 requests",
      content:
        "The external payment API rate limit was increased to 10000 req/min this week after the SLA renegotiation.",
      files: [],
      tags: ["rate-limit", "api", "recent"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-1",
      type: "learning",
      title: "Deployment pipeline migrated to GitHub Actions yesterday",
      content:
        "We moved CI/CD from Jenkins to GitHub Actions yesterday. New workflow file is at .github/workflows/deploy.yml.",
      files: [],
      tags: ["deployment", "github-actions", "recent"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-2",
      type: "learning",
      title: "Database SSL certificates rotated this morning",
      content:
        "SSL certs for the production database were rotated this morning. Update DATABASE_URL if connections drop.",
      files: [],
      tags: ["ssl", "certificate", "recent"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-3",
      type: "learning",
      title: "Staging environment upgraded to Node 22 today",
      content:
        "Staging was upgraded to Node 22 today. Watch for ESM compatibility issues in legacy modules.",
      files: [],
      tags: ["node", "upgrade", "staging", "recent"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-4",
      type: "learning",
      title: "New onboarding checklist published to the team wiki today",
      content:
        "The updated onboarding checklist is live in Notion as of today. Links to all tool setup guides.",
      files: [],
      tags: ["onboarding", "wiki", "recent"],
      confidence: 0.7,
      sourceCount: 1,
    },
    // 5 entries for 7-day bucket (5..9)
    {
      id: "temporal-5",
      type: "learning",
      title: "New deployment process rolled out last sprint",
      content:
        "Since last sprint we require smoke tests to pass before promoting to production. Added to deploy script.",
      files: [],
      tags: ["deployment", "smoke-test", "sprint"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-6",
      type: "learning",
      title: "Feature flag system replaced with Unleash last week",
      content:
        "We replaced the homegrown feature flag system with Unleash last week. All flags migrated to the dashboard.",
      files: [],
      tags: ["feature-flag", "unleash", "last-week"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-7",
      type: "learning",
      title: "Slack alerting channel renamed to platform-alerts last week",
      content:
        "The #alerts channel was renamed to #platform-alerts last week. Update PagerDuty routing rules.",
      files: [],
      tags: ["slack", "alerting", "last-week"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-8",
      type: "learning",
      title: "API versioning policy updated to require deprecation notice",
      content:
        "As of last week, breaking API changes require a 30-day deprecation notice in the changelog.",
      files: [],
      tags: ["api", "versioning", "deprecation"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-9",
      type: "learning",
      title: "Sentry error budget threshold tightened to 0.1 percent",
      content:
        "The error budget SLO was tightened to 0.1% last week. Alerts now fire sooner.",
      files: [],
      tags: ["sentry", "slo", "error-budget"],
      confidence: 0.7,
      sourceCount: 1,
    },
    // 5 entries for 30-day bucket (10..14)
    {
      id: "temporal-10",
      type: "learning",
      title: "Monorepo migration completed last month",
      content:
        "The codebase moved to a Turborepo monorepo last month. All packages live under apps/ and packages/.",
      files: [],
      tags: ["monorepo", "turborepo", "migration"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-11",
      type: "learning",
      title: "TypeScript strict mode enforced across all packages last month",
      content:
        "Strict mode was enabled project-wide last month. No implicit any. All packages now pass strict checks.",
      files: [],
      tags: ["typescript", "strict", "last-month"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-12",
      type: "learning",
      title: "Redis cache layer added to reduce database load last month",
      content:
        "A Redis caching layer was introduced last month. Cache TTL is 5 minutes for read-heavy endpoints.",
      files: [],
      tags: ["redis", "cache", "last-month"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-13",
      type: "learning",
      title: "Pull request template mandated for all feature branches",
      content:
        "As of last month, all PRs must fill out the PR template including test plan and rollback steps.",
      files: [],
      tags: ["pull-request", "template", "last-month"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-14",
      type: "learning",
      title: "OpenTelemetry tracing added to all HTTP handlers last month",
      content:
        "OTEL trace spans now wrap every HTTP handler. Use the trace context for distributed debugging.",
      files: [],
      tags: ["opentelemetry", "tracing", "last-month"],
      confidence: 0.7,
      sourceCount: 1,
    },
    // 5 entries for 90-day bucket (15..19)
    {
      id: "temporal-15",
      type: "learning",
      title: "AWS account consolidated to single organization three months ago",
      content:
        "All AWS sub-accounts were consolidated under the org root three months ago. Use SSO for access.",
      files: [],
      tags: ["aws", "organization", "three-months"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-16",
      type: "learning",
      title: "On-call rotation moved to weekly cadence three months ago",
      content:
        "We switched from biweekly to weekly on-call rotations three months ago. PagerDuty schedule updated.",
      files: [],
      tags: ["on-call", "rotation", "three-months"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-17",
      type: "learning",
      title: "Data retention policy tightened to 90 days three months ago",
      content:
        "PII retention was reduced to 90 days three months ago to comply with GDPR. Purge jobs run nightly.",
      files: [],
      tags: ["data-retention", "gdpr", "three-months"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-18",
      type: "learning",
      title: "GraphQL API deprecated in favour of REST three months ago",
      content:
        "The GraphQL endpoint was deprecated three months ago. All clients should migrate to the REST API.",
      files: [],
      tags: ["graphql", "deprecated", "rest"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "temporal-19",
      type: "learning",
      title: "Kubernetes cluster migrated to EKS three months ago",
      content:
        "We moved from self-managed k8s to AWS EKS three months ago. Helm charts live in the infra repo.",
      files: [],
      tags: ["kubernetes", "eks", "three-months"],
      confidence: 0.7,
      sourceCount: 1,
    },
  ];

  for (const entry of temporalEntries) {
    insertEntry(db, entry);
  }

  // Time-travel: update temporal entry timestamps to simulate age
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  const temporalTimestamps: Array<{ id: string; daysAgo: number }> = [
    { id: "temporal-0", daysAgo: 1 },
    { id: "temporal-1", daysAgo: 1 },
    { id: "temporal-2", daysAgo: 1 },
    { id: "temporal-3", daysAgo: 1 },
    { id: "temporal-4", daysAgo: 1 },
    { id: "temporal-5", daysAgo: 7 },
    { id: "temporal-6", daysAgo: 7 },
    { id: "temporal-7", daysAgo: 7 },
    { id: "temporal-8", daysAgo: 7 },
    { id: "temporal-9", daysAgo: 7 },
    { id: "temporal-10", daysAgo: 30 },
    { id: "temporal-11", daysAgo: 30 },
    { id: "temporal-12", daysAgo: 30 },
    { id: "temporal-13", daysAgo: 30 },
    { id: "temporal-14", daysAgo: 30 },
    { id: "temporal-15", daysAgo: 90 },
    { id: "temporal-16", daysAgo: 90 },
    { id: "temporal-17", daysAgo: 90 },
    { id: "temporal-18", daysAgo: 90 },
    { id: "temporal-19", daysAgo: 90 },
  ];

  for (const { id, daysAgo } of temporalTimestamps) {
    const ts = new Date(now - daysAgo * MS_PER_DAY).toISOString();
    db.run(
      `UPDATE entries SET created_at=?, last_confirmed=? WHERE id=?`,
      [ts, ts, id],
    );
  }

  // ---- 10 ghost entries (ghost-0 … ghost-9) ------------------------------

  const ghostEntries: EntryRow[] = [
    {
      id: "ghost-0",
      type: "ghost_knowledge",
      title: "Production deploy requires 2 approvals",
      content:
        "Team rule: all production deployments require 2 approvals from senior engineers.",
      files: [],
      tags: ["production", "deploy", "approval"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-1",
      type: "ghost_knowledge",
      title: "No direct database writes in production",
      content:
        "Team rule: all production data mutations must go through the migration pipeline.",
      files: [],
      tags: ["production", "database", "migration"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-2",
      type: "ghost_knowledge",
      title: "Secrets must never be committed to git history",
      content:
        "Team rule: secrets, tokens, and API keys must never appear in git commits. Use environment variables.",
      files: [],
      tags: ["secrets", "git", "security"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-3",
      type: "ghost_knowledge",
      title: "All external API calls must have timeout and retry",
      content:
        "Team rule: every HTTP client call to an external service must specify a timeout and retry policy.",
      files: [],
      tags: ["api", "timeout", "retry", "external"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-4",
      type: "ghost_knowledge",
      title: "Code review required before merging to main branch",
      content:
        "Team rule: at least one peer code review is required before any PR is merged to main.",
      files: [],
      tags: ["code-review", "merge", "main"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-5",
      type: "ghost_knowledge",
      title: "Logging must not include personally identifiable information",
      content:
        "Team rule: log lines must never contain PII such as email addresses, phone numbers, or full names.",
      files: [],
      tags: ["logging", "pii", "privacy"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-6",
      type: "ghost_knowledge",
      title: "Feature flags required for all risky production changes",
      content:
        "Team rule: any change that could affect production availability must be gated behind a feature flag.",
      files: [],
      tags: ["feature-flag", "production", "risk"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-7",
      type: "ghost_knowledge",
      title: "Incident postmortems filed within 48 hours of resolution",
      content:
        "Team rule: a blameless postmortem must be filed in Confluence within 48 hours of incident resolution.",
      files: [],
      tags: ["incident", "postmortem", "blameless"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-8",
      type: "ghost_knowledge",
      title: "On-call engineer must acknowledge alerts within five minutes",
      content:
        "Team rule: on-call engineers must acknowledge PagerDuty alerts within 5 minutes or escalate.",
      files: [],
      tags: ["on-call", "pagerduty", "alert"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
    {
      id: "ghost-9",
      type: "ghost_knowledge",
      title: "Unit tests required for all new utility functions",
      content:
        "Team rule: every new utility function added to src/utils must have a corresponding unit test.",
      files: [],
      tags: ["unit-test", "utility", "required"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
    },
  ];

  for (const entry of ghostEntries) {
    insertEntry(db, entry);
  }

  // ---- 10 cross-cutting entries (cross-0 … cross-9) ----------------------

  const crossEntries: EntryRow[] = [
    {
      id: "cross-0",
      type: "learning",
      title: "Auth and payments share session state via middleware",
      content:
        "The auth middleware passes userId to payments checkout via session. See auth/middleware.ts and payments/checkout.ts.",
      files: ["src/auth/middleware.ts", "src/payments/checkout.ts"],
      tags: ["auth", "payments", "session"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-1",
      type: "learning",
      title: "Webhook events trigger validation before database writes",
      content:
        "Webhook handlers in api/webhooks.ts validate payloads using utils/validation.ts before writing to the database.",
      files: ["src/api/webhooks.ts", "src/utils/validation.ts"],
      tags: ["webhook", "validation", "database"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-2",
      type: "learning",
      title: "Database connection errors surfaced through auth middleware",
      content:
        "When the database connection fails during auth, the middleware returns 503 instead of 401. See database/connection.ts.",
      files: ["src/auth/middleware.ts", "src/database/connection.ts"],
      tags: ["auth", "database", "503"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-3",
      type: "learning",
      title: "Payment checkout logs structured events to the webhook bus",
      content:
        "After a successful charge, checkout.ts dispatches a structured event to the webhook outbox in api/webhooks.ts.",
      files: ["src/payments/checkout.ts", "src/api/webhooks.ts"],
      tags: ["payments", "webhook", "event"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-4",
      type: "learning",
      title: "Connection pool exhaustion causes validation timeouts",
      content:
        "When database/connection.ts pool is exhausted, validation queries in utils/validation.ts time out.",
      files: ["src/database/connection.ts", "src/utils/validation.ts"],
      tags: ["database", "pool", "validation", "timeout"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-5",
      type: "learning",
      title: "Auth token scope checked before checkout currency conversion",
      content:
        "The checkout flow reads the currency scope claim from the JWT decoded by auth middleware before conversion.",
      files: ["src/auth/middleware.ts", "src/payments/checkout.ts"],
      tags: ["auth", "jwt", "checkout", "currency"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-6",
      type: "learning",
      title: "Validation schemas shared between webhook and checkout handlers",
      content:
        "The order amount Zod schema defined in utils/validation.ts is reused by both checkout.ts and webhooks.ts.",
      files: [
        "src/utils/validation.ts",
        "src/payments/checkout.ts",
        "src/api/webhooks.ts",
      ],
      tags: ["validation", "zod", "shared", "checkout", "webhook"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-7",
      type: "learning",
      title: "Connection health check exposed via webhook ping endpoint",
      content:
        "The /webhook/ping endpoint in api/webhooks.ts runs a lightweight query against database/connection.ts to verify health.",
      files: ["src/api/webhooks.ts", "src/database/connection.ts"],
      tags: ["health-check", "webhook", "database", "ping"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-8",
      type: "learning",
      title: "Auth middleware rejects requests when validation schema outdated",
      content:
        "If the JWT payload does not conform to the latest schema in utils/validation.ts, auth middleware returns 400.",
      files: ["src/auth/middleware.ts", "src/utils/validation.ts"],
      tags: ["auth", "validation", "400"],
      confidence: 0.8,
      sourceCount: 1,
    },
    {
      id: "cross-9",
      type: "learning",
      title: "Checkout retries database writes on transient connection errors",
      content:
        "When database/connection.ts returns a transient error, checkout.ts retries the order insert up to 3 times.",
      files: ["src/payments/checkout.ts", "src/database/connection.ts"],
      tags: ["checkout", "retry", "database", "transient"],
      confidence: 0.8,
      sourceCount: 1,
    },
  ];

  for (const entry of crossEntries) {
    insertEntry(db, entry);
  }

  // ---- 20 noise entries (noise-0 … noise-19) -----------------------------

  const noiseEntries: EntryRow[] = Array.from({ length: 20 }, (_, i) => ({
    id: `noise-${i}`,
    type: "learning" as const,
    title: `General note ${i}`,
    content: `Some general development note about miscellaneous topics for item ${i}.`,
    files: [],
    tags: ["general", "misc"],
    confidence: 0.5,
    sourceCount: 1,
  }));

  for (const entry of noiseEntries) {
    insertEntry(db, entry);
  }
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run BM25 → RRF and return the ranked id list. */
function bm25RankedIds(query: string): string[] {
  const bm25Results: RankedResult[] = searchByBM25(db, query);
  const fused: RankedResult[] = reciprocalRankFusion([bm25Results]);
  return fused.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// describe 1: keyword retrieval
// ---------------------------------------------------------------------------

describe("keyword retrieval", () => {
  const keywordQueries: LabeledQuery[] = [
    { query: "SQLite WAL mode concurrent reads", relevantIds: ["keyword-0"] },
    {
      query: "bun natively without tsc transpilation",
      relevantIds: ["keyword-1"],
    },
    { query: "FTS5 porter stemmer tokenize", relevantIds: ["keyword-2"] },
    {
      query: "Zod schema validation API boundary",
      relevantIds: ["keyword-3"],
    },
    {
      query: "reciprocal rank fusion BM25 file ranked lists",
      relevantIds: ["keyword-4"],
    },
    {
      query: "MCP server stdio transport",
      relevantIds: ["keyword-5"],
    },
    {
      query: "confidence decay half-life entry type",
      relevantIds: ["keyword-6"],
    },
    {
      query: "bun sqlite bundled native compilation gyp",
      relevantIds: ["keyword-7"],
    },
  ];

  test("MRR@5 >= 0.80 across all 8 keyword queries", () => {
    const evaluated = keywordQueries.map((lq) => ({
      rankedIds: bm25RankedIds(lq.query),
      relevantIds: lq.relevantIds,
    }));

    const mrr = computeMRR(evaluated);
    expect(mrr).toBeGreaterThanOrEqual(0.80);
  });
});

// ---------------------------------------------------------------------------
// describe 2: file-specific retrieval
// ---------------------------------------------------------------------------

describe("file-specific retrieval", () => {
  const fileQueries: Array<{
    filePath: string;
    relevantIds: string[];
  }> = [
    {
      filePath: "src/payments/checkout.ts",
      relevantIds: ["file-0", "file-1", "file-2", "file-3"],
    },
    {
      filePath: "src/auth/middleware.ts",
      relevantIds: ["file-4", "file-5", "file-6", "file-7"],
    },
    {
      filePath: "src/database/connection.ts",
      relevantIds: ["file-8", "file-9", "file-10", "file-11"],
    },
    {
      filePath: "src/api/webhooks.ts",
      relevantIds: ["file-12", "file-13", "file-14", "file-15"],
    },
    {
      filePath: "src/utils/validation.ts",
      relevantIds: ["file-16", "file-17", "file-18", "file-19"],
    },
  ];

  test("MRR@5 >= 0.85 across all 5 file-path queries", () => {
    const evaluated = fileQueries.map(({ filePath, relevantIds }) => {
      const fileResults: RankedResult[] = searchByFilePath(db, [filePath]);
      const rankedIds = fileResults.map((r) => r.id);
      return { rankedIds, relevantIds };
    });

    const mrr = computeMRR(evaluated);
    expect(mrr).toBeGreaterThanOrEqual(0.85);
  });
});

// ---------------------------------------------------------------------------
// describe 3: ghost knowledge retrieval
// ---------------------------------------------------------------------------

describe("ghost knowledge retrieval", () => {
  const ghostQueries: LabeledQuery[] = [
    {
      query: "production deploy approvals",
      relevantIds: ["ghost-0"],
    },
    {
      query: "production database writes migration pipeline",
      relevantIds: ["ghost-1"],
    },
    {
      query: "secrets tokens git commits environment variables",
      relevantIds: ["ghost-2"],
    },
    {
      query: "external API calls timeout retry policy",
      relevantIds: ["ghost-3"],
    },
    {
      query: "code review merge main branch",
      relevantIds: ["ghost-4"],
    },
  ];

  test("MRR@5 >= 0.90 across all 5 ghost knowledge queries", () => {
    const evaluated = ghostQueries.map((lq) => ({
      rankedIds: bm25RankedIds(lq.query),
      relevantIds: lq.relevantIds,
    }));

    const mrr = computeMRR(evaluated);
    expect(mrr).toBeGreaterThanOrEqual(0.90);
  });
});

// ---------------------------------------------------------------------------
// describe 4: cross-cutting retrieval
// ---------------------------------------------------------------------------

describe("cross-cutting retrieval", () => {
  const crossQueries: LabeledQuery[] = [
    {
      query: "auth payments session state middleware",
      relevantIds: ["cross-0"],
    },
    {
      query: "webhook validation database writes",
      relevantIds: ["cross-1"],
    },
    {
      query: "database connection failure auth 503",
      relevantIds: ["cross-2"],
    },
    {
      query: "checkout payment event webhook outbox",
      relevantIds: ["cross-3"],
    },
    {
      query: "connection pool exhausted validation timeout",
      relevantIds: ["cross-4"],
    },
  ];

  test("MRR@5 >= 0.50 across all 5 cross-cutting queries", () => {
    const evaluated = crossQueries.map((lq) => ({
      rankedIds: bm25RankedIds(lq.query),
      relevantIds: lq.relevantIds,
    }));

    const mrr = computeMRR(evaluated);
    expect(mrr).toBeGreaterThanOrEqual(0.50);
  });
});

// ---------------------------------------------------------------------------
// describe 5: aggregate performance
// ---------------------------------------------------------------------------

describe("aggregate performance", () => {
  // All 23 labeled queries assembled inline so this describe block is
  // self-contained and the aggregate does not depend on ordering of other
  // describe blocks.
  const allLabeledBm25Queries: LabeledQuery[] = [
    // keyword (8)
    { query: "SQLite WAL mode concurrent reads", relevantIds: ["keyword-0"] },
    {
      query: "bun natively without tsc transpilation",
      relevantIds: ["keyword-1"],
    },
    { query: "FTS5 porter stemmer tokenize", relevantIds: ["keyword-2"] },
    {
      query: "Zod schema validation API boundary",
      relevantIds: ["keyword-3"],
    },
    {
      query: "reciprocal rank fusion BM25 file ranked lists",
      relevantIds: ["keyword-4"],
    },
    { query: "MCP server stdio transport", relevantIds: ["keyword-5"] },
    {
      query: "confidence decay half-life entry type",
      relevantIds: ["keyword-6"],
    },
    {
      query: "bun sqlite bundled native compilation gyp",
      relevantIds: ["keyword-7"],
    },
    // ghost (5)
    { query: "production deploy approvals", relevantIds: ["ghost-0"] },
    {
      query: "production database writes migration pipeline",
      relevantIds: ["ghost-1"],
    },
    {
      query: "secrets tokens git commits environment variables",
      relevantIds: ["ghost-2"],
    },
    {
      query: "external API calls timeout retry policy",
      relevantIds: ["ghost-3"],
    },
    { query: "code review merge main branch", relevantIds: ["ghost-4"] },
    // cross-cutting (5)
    {
      query: "auth payments session state middleware",
      relevantIds: ["cross-0"],
    },
    {
      query: "webhook validation database writes",
      relevantIds: ["cross-1"],
    },
    {
      query: "database connection failure auth 503",
      relevantIds: ["cross-2"],
    },
    {
      query: "checkout payment event webhook outbox",
      relevantIds: ["cross-3"],
    },
    {
      query: "connection pool exhausted validation timeout",
      relevantIds: ["cross-4"],
    },
  ];

  // File queries contribute their own reciprocal rank scores to the aggregate.
  const allFileQueries: Array<{ filePath: string; relevantIds: string[] }> = [
    {
      filePath: "src/payments/checkout.ts",
      relevantIds: ["file-0", "file-1", "file-2", "file-3"],
    },
    {
      filePath: "src/auth/middleware.ts",
      relevantIds: ["file-4", "file-5", "file-6", "file-7"],
    },
    {
      filePath: "src/database/connection.ts",
      relevantIds: ["file-8", "file-9", "file-10", "file-11"],
    },
    {
      filePath: "src/api/webhooks.ts",
      relevantIds: ["file-12", "file-13", "file-14", "file-15"],
    },
  ];

  test("overall MRR@5 >= 0.70 across all 22+ labeled queries", () => {
    const bm25Evaluated = allLabeledBm25Queries.map((lq) => ({
      rankedIds: bm25RankedIds(lq.query),
      relevantIds: lq.relevantIds,
    }));

    const fileEvaluated = allFileQueries.map(({ filePath, relevantIds }) => {
      const fileResults: RankedResult[] = searchByFilePath(db, [filePath]);
      return { rankedIds: fileResults.map((r) => r.id), relevantIds };
    });

    const allEvaluated = [...bm25Evaluated, ...fileEvaluated];
    const mrr = computeMRR(allEvaluated);
    expect(mrr).toBeGreaterThanOrEqual(0.70);
  });

  test("all searches complete in < 500ms total", () => {
    const start = performance.now();

    for (const { query } of allLabeledBm25Queries) {
      searchByBM25(db, query);
    }
    for (const { filePath } of allFileQueries) {
      searchByFilePath(db, [filePath]);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test("each individual search completes in < 50ms", () => {
    for (const { query } of allLabeledBm25Queries) {
      const start = performance.now();
      searchByBM25(db, query);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    }

    for (const { filePath } of allFileQueries) {
      const start = performance.now();
      searchByFilePath(db, [filePath]);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    }
  });
});
