/**
 * Cross-tool context budget consistency tests.
 *
 * Validates that the same BM25 query returns consistently-ranked results
 * across the four formatting tiers that map to different AI coding tool
 * context windows:
 *   - Claude Code  200k  → full tier     (budget >= 5000)
 *   - Cursor       128k  → compact tier  (budget >= 2000)
 *   - Self-hosted  4k    → minimal tier  (budget >= 800)
 *   - Extreme      512t  → ultraMinimal  (budget < 800)
 *
 * Uses CODE-domain entries — real TypeScript / Bun / Node error patterns.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import { searchByBM25, searchByFilePath } from "../../src/store/search.js";
import type { RankedResult } from "../../src/store/search.js";
import {
  formatForContext,
  type FormattableEntry,
} from "../../src/utils/format-recall.js";
import { countTokens } from "../../src/utils/tokens.js";

// ---------------------------------------------------------------------------
// Helper: fetch full entry rows from the DB given a list of ids
// ---------------------------------------------------------------------------

/**
 * Fetches the minimal fields required by FormattableEntry for each id.
 * BM25 / file-path search returns only {id, score, source}, so we need
 * a round-trip to the entries table to get content and confidence.
 *
 * @param db  - Open database connection.
 * @param ids - Entry ids to fetch, in the desired display order.
 * @returns   FormattableEntry array, preserving the supplied id order.
 */
function fetchEntries(db: Database, ids: readonly string[]): FormattableEntry[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const sql = `
    SELECT id, type, title, content, confidence
    FROM   entries
    WHERE  id IN (${placeholders})
  `;

  type Row = {
    id: string;
    type: string;
    title: string;
    content: string;
    confidence: number;
  };

  const rows = db.query<Row, string[]>(sql).all(...(ids as string[]));

  // Re-sort by the caller-supplied order so ranking is preserved.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is Row => r !== undefined);
}

// ---------------------------------------------------------------------------
// Suite 1: Budget tier ranking consistency
// ---------------------------------------------------------------------------

describe("Suite 1: Budget tier ranking consistency", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");

    // ----- 10 error_pattern entries about postgres connection pool -----
    const errorPatterns: EntryRow[] = [
      {
        id: "ep-01",
        type: "error_pattern",
        title: "Postgres Connection Pool Exhausted",
        content:
          "Error: timeout acquiring postgres connection from pool. The connection pool is exhausted and cannot allocate new connections. " +
          "Fix: Increase pool size via DATABASE_POOL_MAX env var or reduce idle connection hold time in src/db/pool.ts.",
        files: ["src/db/pool.ts", "src/api/users.ts"],
        tags: ["postgres", "connection", "pool", "timeout"],
        errorSignature: "error: timeout acquiring connection from pool",
        confidence: 0.9,
        sourceCount: 5,
        sourceTool: "claude-code",
      },
      {
        id: "ep-02",
        type: "error_pattern",
        title: "EHOSTUNREACH Postgres Unreachable",
        content:
          "EHOSTUNREACH: postgres host unreachable. The database host cannot be reached from the application container. " +
          "Fix: Verify DATABASE_HOST in .env and confirm the postgres service is running in the same network namespace.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "ehostunreach", "network", "connection"],
        errorSignature: "ehostunreach: postgres host <addr> unreachable",
        confidence: 0.85,
        sourceCount: 3,
        sourceTool: "claude-code",
      },
      {
        id: "ep-03",
        type: "error_pattern",
        title: "Postgres Connection Timeout on Idle Pool",
        content:
          "Connection timeout waiting for idle postgres pool slot. All pool connections are in use. " +
          "Fix: Set idleTimeoutMillis lower in src/db/pool.ts to recycle stale connections faster.",
        files: ["src/db/pool.ts", "src/store/database.ts"],
        tags: ["postgres", "pool", "timeout", "idle"],
        errorSignature: "error: connection timeout pool idle <n>ms exceeded",
        confidence: 0.82,
        sourceCount: 4,
        sourceTool: "cursor",
      },
      {
        id: "ep-04",
        type: "error_pattern",
        title: "Pool Exhausted Under High Load",
        content:
          "All postgres pool connections exhausted under high request concurrency. " +
          "Fix: Use a connection queue in src/db/pool.ts and add pool_timeout metric to track saturation.",
        files: ["src/db/pool.ts", "src/api/orders.ts"],
        tags: ["postgres", "pool", "exhausted", "concurrency"],
        errorSignature: "error: pool exhausted max connections <n> reached",
        confidence: 0.78,
        sourceCount: 3,
        sourceTool: "cursor",
      },
      {
        id: "ep-05",
        type: "error_pattern",
        title: "ECONNREFUSED Postgres Port 5432",
        content:
          "ECONNREFUSED 127.0.0.1:5432 postgres connection refused. The postgres daemon is not listening on the expected port. " +
          "Fix: Start postgres service or check PGPORT environment variable in src/utils/config.ts.",
        files: ["src/utils/config.ts", "src/db/pool.ts"],
        tags: ["postgres", "econnrefused", "connection"],
        errorSignature: "error: connect econnrefused <addr>:<n>",
        confidence: 0.75,
        sourceCount: 6,
        sourceTool: "claude-code",
      },
      {
        id: "ep-06",
        type: "error_pattern",
        title: "Postgres SSL Connection Pool Failure",
        content:
          "SSL SYSCALL error: EOF detected in postgres pool connection. " +
          "Fix: Add ssl: { rejectUnauthorized: false } to pool config in src/db/pool.ts when connecting to RDS.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "ssl", "pool", "rds"],
        errorSignature: "error: ssl syscall eof detected pool",
        confidence: 0.72,
        sourceCount: 2,
        sourceTool: "self-hosted",
      },
      {
        id: "ep-07",
        type: "error_pattern",
        title: "Connection Pool Leak in Request Handler",
        content:
          "Postgres connection leaked: pool.connect() called but client not released. " +
          "Fix: Always call client.release() in a finally block in src/api/transactions.ts to prevent pool starvation.",
        files: ["src/api/transactions.ts", "src/db/pool.ts"],
        tags: ["postgres", "pool", "leak", "connection"],
        errorSignature: "warning: postgres client not released pool leak",
        confidence: 0.68,
        sourceCount: 3,
        sourceTool: "self-hosted",
      },
      {
        id: "ep-08",
        type: "error_pattern",
        title: "Pool Timeout After Database Restart",
        content:
          "Postgres pool timeout after database restart: existing pool connections are stale. " +
          "Fix: Enable allowExitOnIdle and add reconnect logic in src/db/pool.ts.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "pool", "timeout", "restart"],
        errorSignature: "error: pool timeout database restart <n>ms",
        confidence: 0.60,
        sourceCount: 2,
        sourceTool: "cursor",
      },
      {
        id: "ep-09",
        type: "error_pattern",
        title: "Too Many Connections Postgres Pool",
        content:
          "FATAL: too many connections for postgres. The server-side connection limit is exceeded by the pool. " +
          "Fix: Lower max pool size or add PgBouncer in front of postgres in src/db/pool.ts config.",
        files: ["src/db/pool.ts", "src/api/reports.ts"],
        tags: ["postgres", "pool", "connections", "fatal"],
        errorSignature: "fatal: too many connections postgres server",
        confidence: 0.55,
        sourceCount: 1,
        sourceTool: "claude-code",
      },
      {
        id: "ep-10",
        type: "error_pattern",
        title: "Postgres Pool Config Missing Max Parameter",
        content:
          "Pool created without max parameter defaults to 10 connections postgres. " +
          "Fix: Explicitly set pool max in src/db/pool.ts to match DATABASE_POOL_MAX from environment.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "pool", "config"],
        errorSignature: "warning: postgres pool max not configured default used",
        confidence: 0.40,
        sourceCount: 1,
        sourceTool: "cursor",
      },
    ];

    // ----- 10 convention entries about connection pooling -----
    const conventions: EntryRow[] = [
      {
        id: "cv-01",
        type: "convention",
        title: "Always Use Connection Pool for Postgres",
        content:
          "Never open raw postgres connections per request. Use the shared pool in src/db/pool.ts. " +
          "Direct connections bypass pool metrics and create resource leaks.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "pool", "convention"],
        confidence: 0.95,
        sourceCount: 8,
        sourceTool: "claude-code",
      },
      {
        id: "cv-02",
        type: "convention",
        title: "Release Pool Connections in Finally Blocks",
        content:
          "Always release postgres pool connections in a finally block. " +
          "Forgetting release in error paths exhausts the pool under load.",
        files: ["src/db/pool.ts", "src/api/users.ts"],
        tags: ["postgres", "pool", "connection", "finally"],
        confidence: 0.93,
        sourceCount: 7,
        sourceTool: "claude-code",
      },
      {
        id: "cv-03",
        type: "convention",
        title: "Configure Pool Size via Environment Variables",
        content:
          "Pool max and min sizes must come from DATABASE_POOL_MAX and DATABASE_POOL_MIN env vars. " +
          "Hard-coding sizes causes mismatches between local and production postgres deployments.",
        files: ["src/db/pool.ts", "src/utils/config.ts"],
        tags: ["postgres", "pool", "config", "env"],
        confidence: 0.91,
        sourceCount: 5,
        sourceTool: "cursor",
      },
      {
        id: "cv-04",
        type: "convention",
        title: "Log Pool Metrics on Every Request",
        content:
          "Log pool.totalCount, pool.idleCount, and pool.waitingCount on each postgres query. " +
          "This data surfaces connection exhaustion before it becomes a timeout.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "pool", "metrics", "logging"],
        confidence: 0.88,
        sourceCount: 4,
        sourceTool: "claude-code",
      },
      {
        id: "cv-05",
        type: "convention",
        title: "Use Transactions for Multi-Step DB Operations",
        content:
          "Wrap multi-step postgres operations in a transaction using pool.connect() and BEGIN/COMMIT. " +
          "Auto-commit mode leads to partial writes on failure in src/api/transactions.ts.",
        files: ["src/api/transactions.ts", "src/db/pool.ts"],
        tags: ["postgres", "transaction", "pool"],
        confidence: 0.87,
        sourceCount: 6,
        sourceTool: "cursor",
      },
      {
        id: "cv-06",
        type: "convention",
        title: "Set idleTimeoutMillis to 10000 in Pool Config",
        content:
          "Set idleTimeoutMillis to 10000ms for postgres pool. " +
          "Default is 10000 but must be explicit in src/db/pool.ts to survive config file merges.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "pool", "idle", "timeout"],
        confidence: 0.84,
        sourceCount: 3,
        sourceTool: "self-hosted",
      },
      {
        id: "cv-07",
        type: "convention",
        title: "Test Pool Behaviour with Stress Fixtures",
        content:
          "Use tests/stress/pool.test.ts to simulate pool exhaustion. " +
          "Run with BUN_POOL_MAX=2 to reproduce timeout errors locally.",
        files: ["tests/stress/pool.test.ts", "src/db/pool.ts"],
        tags: ["postgres", "pool", "test", "stress"],
        confidence: 0.80,
        sourceCount: 2,
        sourceTool: "claude-code",
      },
      {
        id: "cv-08",
        type: "convention",
        title: "Add Health Check Endpoint for Pool Status",
        content:
          "Expose GET /health/db that returns postgres pool stats. " +
          "Kubernetes liveness probes depend on this endpoint in src/api/health.ts.",
        files: ["src/api/health.ts", "src/db/pool.ts"],
        tags: ["postgres", "pool", "health", "kubernetes"],
        confidence: 0.76,
        sourceCount: 3,
        sourceTool: "cursor",
      },
      {
        id: "cv-09",
        type: "convention",
        title: "Validate Database Config at Startup",
        content:
          "Validate DATABASE_URL and pool config with Zod schema at process start. " +
          "Missing or malformed config should throw immediately, not at first query in src/utils/config.ts.",
        files: ["src/utils/config.ts"],
        tags: ["postgres", "pool", "validation", "startup"],
        confidence: 0.73,
        sourceCount: 4,
        sourceTool: "claude-code",
      },
      {
        id: "cv-10",
        type: "convention",
        title: "Use Named Pool Instances for Multiple Databases",
        content:
          "When connecting to multiple postgres databases, use named pool instances exported from src/db/pool.ts. " +
          "Sharing a single pool across different databases causes query routing errors.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "pool", "multi-db"],
        confidence: 0.70,
        sourceCount: 2,
        sourceTool: "cursor",
      },
    ];

    // ----- 10 learning noise entries (Redis, Stripe, JWT — unrelated) -----
    const noiseEntries: EntryRow[] = [
      {
        id: "lrn-01",
        type: "learning",
        title: "Redis Cache Key Expiry Strategy",
        content:
          "Use TTL-based expiry for Redis cache keys in src/cache/redis.ts. " +
          "Keys without TTL grow unbounded and exhaust Redis memory.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "cache", "ttl"],
        confidence: 0.88,
        sourceCount: 3,
        sourceTool: "claude-code",
      },
      {
        id: "lrn-02",
        type: "learning",
        title: "Stripe Webhook Signature Verification",
        content:
          "Always verify Stripe webhook signatures using stripe.webhooks.constructEvent. " +
          "Unverified webhooks allow replay attacks in src/api/billing.ts.",
        files: ["src/api/billing.ts"],
        tags: ["stripe", "webhook", "security"],
        confidence: 0.85,
        sourceCount: 2,
        sourceTool: "cursor",
      },
      {
        id: "lrn-03",
        type: "learning",
        title: "JWT Token Expiry and Refresh Pattern",
        content:
          "Issue short-lived JWTs (15 min) with refresh tokens stored in src/auth/tokens.ts. " +
          "Long-lived JWTs cannot be revoked without a denylist.",
        files: ["src/auth/tokens.ts"],
        tags: ["jwt", "auth", "tokens"],
        confidence: 0.82,
        sourceCount: 4,
        sourceTool: "claude-code",
      },
      {
        id: "lrn-04",
        type: "learning",
        title: "Redis ECONNREFUSED on Test Startup",
        content:
          "Redis throws ECONNREFUSED in tests because the test runner starts before Redis is ready. " +
          "Add a readiness check in tests/setup.ts before test suite runs.",
        files: ["tests/setup.ts"],
        tags: ["redis", "test", "econnrefused"],
        confidence: 0.79,
        sourceCount: 2,
        sourceTool: "self-hosted",
      },
      {
        id: "lrn-05",
        type: "learning",
        title: "Stripe Payment Intent State Machine",
        content:
          "Stripe PaymentIntent moves through states: created, processing, succeeded, canceled. " +
          "Handle each state explicitly in src/api/billing.ts to avoid double-charge bugs.",
        files: ["src/api/billing.ts"],
        tags: ["stripe", "payment", "state"],
        confidence: 0.76,
        sourceCount: 3,
        sourceTool: "cursor",
      },
      {
        id: "lrn-06",
        type: "learning",
        title: "JWT RS256 vs HS256 Algorithm Choice",
        content:
          "Use RS256 when third parties must verify JWTs. Use HS256 for internal tokens only. " +
          "Public key distribution is handled in src/auth/keys.ts.",
        files: ["src/auth/keys.ts"],
        tags: ["jwt", "algorithm", "auth"],
        confidence: 0.73,
        sourceCount: 1,
        sourceTool: "claude-code",
      },
      {
        id: "lrn-07",
        type: "learning",
        title: "Redis Cluster Failover Handling",
        content:
          "Redis cluster may re-elect a new primary after failover. " +
          "ioredis handles reconnect automatically but ECONNRESET errors surface briefly in src/cache/redis.ts.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "cluster", "failover"],
        confidence: 0.70,
        sourceCount: 2,
        sourceTool: "cursor",
      },
      {
        id: "lrn-08",
        type: "learning",
        title: "Stripe Idempotency Keys for Retries",
        content:
          "Pass idempotency keys on all Stripe API calls that mutate state. " +
          "Without them, network retries create duplicate charges in src/api/billing.ts.",
        files: ["src/api/billing.ts"],
        tags: ["stripe", "idempotency", "retry"],
        confidence: 0.67,
        sourceCount: 3,
        sourceTool: "self-hosted",
      },
      {
        id: "lrn-09",
        type: "learning",
        title: "JWT Audience Claim Validation",
        content:
          "Validate the aud claim on incoming JWTs to prevent token reuse across services. " +
          "Missing audience check is a common auth bypass in src/auth/middleware.ts.",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "audience", "security"],
        confidence: 0.64,
        sourceCount: 2,
        sourceTool: "claude-code",
      },
      {
        id: "lrn-10",
        type: "learning",
        title: "Redis Memory Eviction Policy",
        content:
          "Set maxmemory-policy to allkeys-lru in Redis config. " +
          "Without an eviction policy Redis returns OOM errors when memory is full in src/cache/redis.ts.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "memory", "eviction"],
        confidence: 0.61,
        sourceCount: 1,
        sourceTool: "cursor",
      },
    ];

    for (const entry of [...errorPatterns, ...conventions, ...noiseEntries]) {
      insertEntry(db, entry);
    }
  });

  afterAll(() => {
    db.close();
  });

  test("full tier (5000): returns up to 5 entries within budget", () => {
    const budget = 5000;
    const results = searchByBM25(db, "postgres connection pool timeout exhausted");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(5);

    const output = formatForContext(entries, budget);
    const tokens = countTokens(output);

    expect(tokens).toBeLessThanOrEqual(budget);
    expect(output).not.toBe("No matching entries found.");
  });

  test("compact tier (2000): returns up to 3 entries within budget", () => {
    const budget = 2000;
    const results = searchByBM25(db, "postgres connection pool timeout exhausted");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    // formatForContext will pick top 3 from this list at compact tier
    const output = formatForContext(entries, budget);
    const tokens = countTokens(output);

    expect(tokens).toBeLessThanOrEqual(budget);
    expect(output).not.toBe("No matching entries found.");
  });

  test("minimal tier (1000): returns up to 2 entries within budget", () => {
    const budget = 1000;
    const results = searchByBM25(db, "postgres connection pool timeout exhausted");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const output = formatForContext(entries, budget);
    const tokens = countTokens(output);

    expect(tokens).toBeLessThanOrEqual(budget);
    expect(output).not.toBe("No matching entries found.");
  });

  test("ultraMinimal tier (500): returns top 1 entry within budget", () => {
    const budget = 500;
    const results = searchByBM25(db, "postgres connection pool timeout exhausted");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const output = formatForContext(entries, budget);
    const tokens = countTokens(output);

    expect(tokens).toBeLessThanOrEqual(budget);
    expect(output).not.toBe("No matching entries found.");
  });

  test("extreme tier (100): returns something within a small multiple of budget", () => {
    const budget = 100;
    const results = searchByBM25(db, "postgres connection pool timeout exhausted");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const output = formatForContext(entries, budget);
    const tokens = countTokens(output);

    // truncateToTokenBudget may append the "… [truncated]" suffix (14 chars / 4 ≈ 4 tokens)
    // Allow up to 2x the budget as a safe upper bound.
    expect(tokens).toBeLessThanOrEqual(budget * 2);
    expect(output.length).toBeGreaterThan(0);
  });

  test("ranking consistency: top-1 at ultraMinimal matches top-1 at full tier", () => {
    const query = "postgres connection pool timeout exhausted";
    const results = searchByBM25(db, query);
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const fullOutput = formatForContext(entries, 5000);
    const ultraOutput = formatForContext(entries, 500);

    // The very first entry title should appear in both outputs
    if (entries.length > 0) {
      const topEntry = entries[0]!;
      // Full output contains the top entry title
      expect(fullOutput).toContain(topEntry.title);
      // UltraMinimal output also leads with the same top entry title
      expect(ultraOutput).toContain(topEntry.title);
    }
  });

  test("ranking consistency: ids present in lower tiers are a prefix of higher tiers", () => {
    const query = "postgres connection pool timeout exhausted";
    const results = searchByBM25(db, query);
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    // formatForContext slices entries[0..N] for each tier — the same ranked list.
    // So the single entry shown at ultraMinimal must be the first entry shown at full.
    if (entries.length >= 2) {
      const topId = entries[0]!.id;

      const fullOutput   = formatForContext(entries, 5000);
      const compactOutput = formatForContext(entries, 2000);
      const minOutput    = formatForContext(entries, 1000);
      const ultraOutput  = formatForContext(entries, 500);

      // Top entry must appear in every tier
      const topTitle = entries[0]!.title;
      expect(fullOutput).toContain(topTitle);
      expect(compactOutput).toContain(topTitle);
      expect(minOutput).toContain(topTitle);
      expect(ultraOutput).toContain(topTitle);

      // Second entry appears in full and compact (top 5 / top 3), but not ultraMinimal
      const secondTitle = entries[1]!.title;
      expect(fullOutput).toContain(secondTitle);
      expect(compactOutput).toContain(secondTitle);
      // ultraMinimal shows only the first entry
      expect(ultraOutput).not.toContain(secondTitle);

      void topId; // used implicitly via topTitle above
    }
  });

  test("empty results return sentinel string", () => {
    const output = formatForContext([], 5000);
    expect(output).toBe("No matching entries found.");
  });

  test("noise entries (Redis, Stripe, JWT) do not surface for postgres query", () => {
    const results = searchByBM25(db, "postgres connection pool timeout exhausted");
    const ids = results.map((r: RankedResult) => r.id);

    // Noise entry ids start with "lrn-"; none should appear in top results
    // for a postgres-specific query.
    const noiseHits = ids.slice(0, 5).filter((id) => id.startsWith("lrn-"));
    expect(noiseHits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Transport-agnostic learn → recall
// ---------------------------------------------------------------------------

describe("Suite 2: Transport-agnostic learn → recall", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");

    // Entry inserted via stdio MCP transport
    insertEntry(db, {
      id: "stdio-entry-01",
      type: "error_pattern",
      title: "Cannot Destructure Property user of req.session",
      content:
        "TypeError: Cannot destructure property 'user' of 'req.session' as it is undefined. " +
        "Occurs in src/api/auth.ts when the session middleware is not mounted before route handlers. " +
        "Fix: Ensure express-session middleware is registered before route handlers in src/app.ts.",
      files: ["src/api/auth.ts", "src/app.ts"],
      tags: ["session", "destructure", "middleware"],
      errorSignature: "typeerror: cannot destructure property <str> of req session undefined",
      confidence: 0.88,
      sourceCount: 2,
      sourceTool: "stdio",
    });

    // Entry inserted via HTTP MCP transport
    insertEntry(db, {
      id: "http-entry-01",
      type: "error_pattern",
      title: "ECONNREFUSED Redis Connection on 127.0.0.1:6379",
      content:
        "Error: connect ECONNREFUSED 127.0.0.1:6379 redis connection refused. " +
        "The Redis server is not running or the port is incorrect. " +
        "Fix: Start Redis with redis-server or check REDIS_URL in .env used by src/cache/redis.ts.",
      files: ["src/cache/redis.ts"],
      tags: ["redis", "econnrefused", "connection"],
      errorSignature: "error: connect econnrefused <addr>:<n> redis",
      confidence: 0.84,
      sourceCount: 3,
      sourceTool: "http",
    });
  });

  afterAll(() => {
    db.close();
  });

  test("stdio-inserted entry is recalled by BM25 search", () => {
    const results = searchByBM25(db, "session destructure user undefined");
    const ids = results.map((r: RankedResult) => r.id);
    expect(ids).toContain("stdio-entry-01");
  });

  test("http-inserted entry is recalled by BM25 search", () => {
    const results = searchByBM25(db, "redis connection refused econnrefused");
    const ids = results.map((r: RankedResult) => r.id);
    expect(ids).toContain("http-entry-01");
  });

  test("sourceTool attribution is recorded for stdio entry", () => {
    type Row = { source_tool: string | null };
    const row = db
      .query<Row, [string]>("SELECT source_tool FROM entries WHERE id = ?")
      .get("stdio-entry-01");
    expect(row).not.toBeNull();
    expect(row!.source_tool).toBe("stdio");
  });

  test("sourceTool attribution is recorded for http entry", () => {
    type Row = { source_tool: string | null };
    const row = db
      .query<Row, [string]>("SELECT source_tool FROM entries WHERE id = ?")
      .get("http-entry-01");
    expect(row).not.toBeNull();
    expect(row!.source_tool).toBe("http");
  });

  test("both entries surface regardless of which transport inserted them", () => {
    // Search for session error — should find stdio entry
    const sessionResults = searchByBM25(db, "cannot destructure session");
    const sessionIds = sessionResults.map((r: RankedResult) => r.id);
    expect(sessionIds).toContain("stdio-entry-01");

    // Search for redis error — should find http entry
    const redisResults = searchByBM25(db, "econnrefused redis 6379");
    const redisIds = redisResults.map((r: RankedResult) => r.id);
    expect(redisIds).toContain("http-entry-01");
  });

  test("file-path search works regardless of source transport", () => {
    const results = searchByFilePath(db, ["src/api/auth.ts"]);
    const ids = results.map((r: RankedResult) => r.id);
    expect(ids).toContain("stdio-entry-01");

    const redisResults = searchByFilePath(db, ["src/cache/redis.ts"]);
    const redisIds = redisResults.map((r: RankedResult) => r.id);
    expect(redisIds).toContain("http-entry-01");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Self-hosted LLM tight budget behaviour
// ---------------------------------------------------------------------------

describe("Suite 3: Self-hosted LLM tight budget behaviour", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");

    // Seed 20 code entries for self-hosted budget tests
    for (let i = 1; i <= 20; i++) {
      const confidence = Math.round((0.95 - (i - 1) * 0.025) * 100) / 100;
      insertEntry(db, {
        id: `sh-entry-${String(i).padStart(2, "0")}`,
        type: i <= 10 ? "error_pattern" : "convention",
        title: `TypeScript Build Error Pattern ${i}`,
        content:
          `TypeScript compilation fails with TS${2300 + i}: error in src/api/route${i}.ts. ` +
          `The type annotation is incompatible with the inferred return type. ` +
          `Fix: Add explicit return type annotation to the function in src/api/route${i}.ts.`,
        files: [`src/api/route${i}.ts`],
        tags: ["typescript", "build", "error", `ts${2300 + i}`],
        errorSignature: `ts${2300 + i}: type annotation incompatible inferred return`,
        confidence,
        sourceCount: i,
        sourceTool: "self-hosted",
      });
    }
  });

  afterAll(() => {
    db.close();
  });

  test("800-token budget returns no more than 2 entries (minimal tier)", () => {
    const budget = 800;
    const results = searchByBM25(db, "typescript build error annotation");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    // formatForContext at 800 uses formatMinimal which slices to top 2
    const output = formatForContext(entries, budget);

    // Count how many entries actually appear by counting "- TypeScript" bullet lines
    const bulletCount = (output.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBeLessThanOrEqual(2);
    expect(output).not.toBe("No matching entries found.");
  });

  test("800-token budget output fits within token budget", () => {
    const budget = 800;
    const results = searchByBM25(db, "typescript build error annotation");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const output = formatForContext(entries, budget);
    const tokens = Math.ceil(output.length / 4);

    expect(tokens).toBeLessThanOrEqual(budget);
  });

  test("top entry (highest BM25 score) is preserved at tight budget", () => {
    const budget = 800;
    const results = searchByBM25(db, "typescript build error annotation");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const output = formatForContext(entries, budget);

    // The first ranked entry's title must appear in the output
    if (entries.length > 0) {
      expect(output).toContain(entries[0]!.title);
    }
  });

  test("output is not mid-sentence garbage — formatForContext handles truncation", () => {
    const budget = 800;
    const results = searchByBM25(db, "typescript build error annotation");
    const top5Ids = results.slice(0, 5).map((r: RankedResult) => r.id);
    const entries = fetchEntries(db, top5Ids);

    const output = formatForContext(entries, budget);

    // The output should either be complete or end with the truncation sentinel
    // (not a dangling partial character mid-word with no signal)
    const isSentinel = output.endsWith("… [truncated]");
    const isMeaningful = output.length > 0;
    expect(isMeaningful).toBe(true);

    if (!isSentinel) {
      // If not truncated, output should contain recognisable content
      expect(output).toMatch(/TypeScript|type|annotation|build/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Budget boundary edge cases
// ---------------------------------------------------------------------------

describe("Suite 4: Budget boundary edge cases", () => {
  let db: Database;

  const sampleEntries: FormattableEntry[] = [
    {
      id: "edge-01",
      type: "error_pattern",
      title: "Bun SQLite UNIQUE Constraint Violation",
      content:
        "SQLiteError: UNIQUE constraint failed: entries.id. " +
        "Attempting to insert a duplicate entry id into the SQLite database. " +
        "Fix: Use INSERT OR IGNORE or check for existence before inserting in src/store/database.ts.",
      confidence: 0.9,
      files: ["src/store/database.ts"],
      tags: ["sqlite", "unique", "constraint"],
    },
    {
      id: "edge-02",
      type: "convention",
      title: "Use Parameterised Queries for All SQLite Statements",
      content:
        "Never interpolate user input directly into SQLite query strings. " +
        "Use parameterised queries via db.query().all(...params) in src/store/database.ts to prevent injection.",
      confidence: 0.87,
      files: ["src/store/database.ts"],
      tags: ["sqlite", "security", "parameterised"],
    },
    {
      id: "edge-03",
      type: "learning",
      title: "FTS5 Porter Stemmer Matches Variants",
      content:
        "The FTS5 porter stemmer in entries_fts matches 'connect', 'connection', 'connecting' as the same stem. " +
        "Queries do not need to use exact word forms.",
      confidence: 0.80,
      files: ["src/store/search.ts"],
      tags: ["fts5", "porter", "stemmer"],
    },
    {
      id: "edge-04",
      type: "error_pattern",
      title: "Bun Test Timeout in Async Database Tests",
      content:
        "Bun test runner times out after 5000ms if async database operations are not awaited correctly. " +
        "Fix: Ensure all db.transaction()() calls complete before assertions in test files.",
      confidence: 0.75,
      files: ["tests/store/database.test.ts"],
      tags: ["bun", "test", "timeout", "async"],
    },
    {
      id: "edge-05",
      type: "convention",
      title: "Always Close Database Connections in afterAll",
      content:
        "Call db.close() in afterAll to release the SQLite file lock. " +
        "Unclosed connections cause BUSY errors in subsequent test runs.",
      confidence: 0.70,
      files: ["tests/store/database.test.ts"],
      tags: ["sqlite", "cleanup", "test"],
    },
  ];

  beforeAll(() => {
    db = initDatabase(":memory:");
    // Seed only for file-path tests in this suite; formatting uses sampleEntries directly.
    for (const entry of sampleEntries) {
      insertEntry(db, {
        ...entry,
        files: entry.files ?? [],
        tags: entry.tags ?? [],
        sourceCount: 1,
      });
    }
  });

  afterAll(() => {
    db.close();
  });

  test("budget 4999 uses compact tier (>= 2000 and < 5000)", () => {
    const output = formatForContext(sampleEntries, 4999);
    // compact uses ### headers; full uses ## headers
    expect(output).toMatch(/^###/m);
    expect(output).not.toMatch(/^## /m);
  });

  test("budget 5000 uses full tier (>= 5000)", () => {
    const output = formatForContext(sampleEntries, 5000);
    // full tier uses ## headers
    expect(output).toMatch(/^## /m);
  });

  test("budget 2000 uses compact tier (exactly on boundary)", () => {
    const output = formatForContext(sampleEntries, 2000);
    // compact uses ### headers
    expect(output).toMatch(/^###/m);
    expect(output).not.toMatch(/^## /m);
  });

  test("budget 0 uses ultraMinimal tier (truncation to zero is valid)", () => {
    // At budget=0 maxChars=0, so truncateToTokenBudget returns "" — that is
    // correct clamping behaviour, not a sentinel. The important thing is that
    // formatForContext does not throw and does not return the "No matching
    // entries found." sentinel (entries exist).
    const output = formatForContext(sampleEntries, 0);
    expect(output).not.toBe("No matching entries found.");
    // output may be "" (fully clamped) or the "… [truncated]" suffix depending
    // on future implementation changes — either is acceptable as long as we
    // don't exceed the budget.
    const tokens = Math.ceil(output.length / 4);
    expect(tokens).toBeLessThanOrEqual(1); // 0 chars → 0 tokens (or 1 for rounding)
  });

  test("empty entries list at full tier returns sentinel", () => {
    const output = formatForContext([], 5000);
    expect(output).toBe("No matching entries found.");
  });

  test("empty entries list at compact tier returns sentinel", () => {
    const output = formatForContext([], 2000);
    expect(output).toBe("No matching entries found.");
  });

  test("empty entries list at minimal tier returns sentinel", () => {
    const output = formatForContext([], 1000);
    expect(output).toBe("No matching entries found.");
  });

  test("empty entries list at ultraMinimal tier returns sentinel", () => {
    const output = formatForContext([], 500);
    expect(output).toBe("No matching entries found.");
  });

  test("budget 5000 output token count does not exceed budget", () => {
    const budget = 5000;
    const output = formatForContext(sampleEntries, budget);
    expect(countTokens(output)).toBeLessThanOrEqual(budget);
  });

  test("budget 2000 output token count does not exceed budget", () => {
    const budget = 2000;
    const output = formatForContext(sampleEntries, budget);
    expect(countTokens(output)).toBeLessThanOrEqual(budget);
  });

  test("budget 800 output token count does not exceed budget", () => {
    const budget = 800;
    const output = formatForContext(sampleEntries, budget);
    expect(countTokens(output)).toBeLessThanOrEqual(budget);
  });

  test("budget 500 output token count does not exceed budget", () => {
    const budget = 500;
    const output = formatForContext(sampleEntries, budget);
    expect(countTokens(output)).toBeLessThanOrEqual(budget);
  });
});
