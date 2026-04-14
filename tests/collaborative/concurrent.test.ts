/**
 * Concurrent team collaboration tests for Gyst.
 *
 * Three suites:
 *   1. 3 developers × 20 ops — parallel feature development (payments / auth / data)
 *   2. Simultaneous learn race — deduplication catches same-signature errors
 *   3. 500 read queries — P50/P95 latency under load on a 200-entry in-memory DB
 *
 * bun:sqlite is synchronous; "parallel" is simulated via Promise.all over async
 * wrappers so the scheduling path mirrors real multi-agent sessions.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import { extractEntry } from "../../src/compiler/extract.js";
import type { LearnInput, KnowledgeEntry } from "../../src/compiler/extract.js";
import { findDuplicate } from "../../src/compiler/deduplicate.js";
import {
  initTeamSchema,
  createTeam,
  createInviteKey,
  joinTeam,
} from "../../src/server/auth.js";
import {
  initActivitySchema,
  logActivity,
  getRecentActivity,
} from "../../src/server/activity.js";
import { searchByBM25 } from "../../src/store/search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the value at the p-th percentile of an array of numbers.
 * Values are sorted ascending before indexing.
 *
 * @param values - Array of numeric measurements.
 * @param p - Percentile in [0, 100].
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  // Clamp to last valid index
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

/** Domain-specific topics for the latency-seeding factory. */
const SEED_DOMAINS = [
  "postgres",
  "prisma",
  "stripe",
  "jwt",
  "redis",
  "zod",
] as const;

type SeedDomain = (typeof SEED_DOMAINS)[number];

/** Realistic error messages and content keyed by domain. */
const DOMAIN_FIXTURES: Record<
  SeedDomain,
  { errorMessage: string; files: string[]; tags: string[] }
> = {
  postgres: {
    errorMessage:
      "Error: connect ECONNREFUSED 127.0.0.1:5432 — PostgreSQL server not accepting connections",
    files: ["src/db/pool.ts", "src/db/prisma.ts"],
    tags: ["postgres", "connection", "pool"],
  },
  prisma: {
    errorMessage:
      "PrismaClientKnownRequestError: Unique constraint failed on the fields: (`email`) at src/api/users.ts:42:18",
    files: ["src/db/prisma.ts", "src/api/users.ts"],
    tags: ["prisma", "unique-constraint", "database"],
  },
  stripe: {
    errorMessage:
      "StripeInvalidRequestError: No such customer: cus_FAKE123 at src/webhooks/stripe.ts:88:12",
    files: ["src/webhooks/stripe.ts", "src/api/payments.ts"],
    tags: ["stripe", "webhook", "payments"],
  },
  jwt: {
    errorMessage:
      "JsonWebTokenError: invalid signature — token tampered or signed with wrong secret at src/auth/middleware.ts:55:9",
    files: ["src/auth/middleware.ts", "src/api/auth.ts"],
    tags: ["jwt", "auth", "token"],
  },
  redis: {
    errorMessage:
      "ReplyError: WRONGTYPE Operation against a key holding the wrong kind of value at src/cache/redis.ts:30:5",
    files: ["src/cache/redis.ts"],
    tags: ["redis", "cache", "wrongtype"],
  },
  zod: {
    errorMessage:
      "ZodError: [{ code: 'invalid_type', expected: 'string', received: 'undefined', path: ['email'] }] at src/api/auth.ts:78:14",
    files: ["src/api/auth.ts", "src/utils/validate.ts"],
    tags: ["zod", "validation", "schema"],
  },
};

/**
 * Seeds a single realistic code entry into the database.
 *
 * @param db     - Open database connection.
 * @param idx    - Numeric index — used to keep IDs and titles unique.
 * @param domain - Knowledge domain for this entry.
 * @returns The generated entry ID.
 */
function seedCodeEntry(db: Database, idx: number, domain: SeedDomain): string {
  const fix = DOMAIN_FIXTURES[domain];
  const id = `seed-${domain}-${idx}`;
  const entry: EntryRow = {
    id,
    type: "error_pattern",
    title: `${domain} error pattern ${idx}: ${fix.tags[0]} issue`,
    content: `Encountered a ${domain} error during production deployment. Root cause: ${fix.errorMessage}. Resolution: check configuration and connection settings for the ${domain} subsystem. Always validate environment variables before initialising client connections.`,
    files: fix.files,
    tags: fix.tags,
    errorSignature: fix.errorMessage.toLowerCase().replace(/\d+/g, "<N>"),
    confidence: 0.75,
    sourceCount: 1,
    sourceTool: "git-hook",
    status: "active",
    scope: "team",
  };
  insertEntry(db, entry);
  return id;
}

// ---------------------------------------------------------------------------
// Suite 1 — 3 developers, parallel feature development (60 ops total)
// ---------------------------------------------------------------------------

describe("Suite 1: 3 developers parallel feature development", () => {
  let db: Database;
  let teamId: string;

  // Each dev gets a stable UUID once provisioned
  const devIds: [string, string, string] = ["", "", ""];

  beforeAll(async () => {
    db = initDatabase(":memory:");
    initTeamSchema(db);
    initActivitySchema(db);

    const team = createTeam(db, "Feature Dev Team");
    teamId = team.teamId;

    // Provision 3 developers in parallel (joinTeam is async due to bcrypt)
    const inviteKeys = [
      createInviteKey(db, teamId),
      createInviteKey(db, teamId),
      createInviteKey(db, teamId),
    ] as const;

    const joined = await Promise.all([
      joinTeam(db, inviteKeys[0], "Alice — Payments"),
      joinTeam(db, inviteKeys[1], "Bob — Auth"),
      joinTeam(db, inviteKeys[2], "Carol — Data Layer"),
    ]);

    devIds[0] = joined[0].developerId;
    devIds[1] = joined[1].developerId;
    devIds[2] = joined[2].developerId;
  });

  afterAll(() => {
    db.close();
  });

  /**
   * Simulates one developer's 20-operation session:
   *   10 insertEntry (learn) + 5 searchByBM25 (recall) + 5 logActivity
   */
  async function runDevSession(
    devIdx: 0 | 1 | 2,
    domain: "payments" | "auth" | "data",
    featureFiles: string[],
    featureTags: string[],
    recallQueries: string[],
    errorMessages: Array<{ errorMessage: string; title: string; content: string }>,
  ): Promise<void> {
    const devId = devIds[devIdx];

    // 10 learn ops
    for (let j = 0; j < 10; j++) {
      const em = errorMessages[j % errorMessages.length]!;
      const id = `dev-${devIdx}-entry-${j}`;
      const entry: EntryRow = {
        id,
        type: "error_pattern",
        title: `${em.title} #${j}`,
        content: em.content,
        files: featureFiles,
        tags: featureTags,
        errorSignature: em.errorMessage.toLowerCase().replace(/\d+/g, "<N>"),
        confidence: 0.7 + (j % 3) * 0.05,
        sourceCount: 1,
        sourceTool: "claude-code",
        status: "active",
        scope: "team",
        developerId: devId,
      };
      insertEntry(db, entry);
      logActivity(db, teamId, devId, "learn", id);
    }

    // 5 recall ops — search for own domain content
    for (let q = 0; q < 5; q++) {
      const query = recallQueries[q % recallQueries.length]!;
      searchByBM25(db, query, undefined, devId);
      logActivity(db, teamId, devId, "recall");
    }

    // 5 extra logActivity calls (conventions / failures lookups)
    const extraActions = ["conventions", "failures", "recall", "conventions", "failures"] as const;
    for (let a = 0; a < 5; a++) {
      logActivity(db, teamId, devId, extraActions[a]!);
    }
  }

  // ── Dev A fixture data — payments/Stripe/webhooks ──────────────────────
  const devAErrors = [
    {
      title: "Stripe webhook signature verification failed",
      content:
        "Stripe webhook verification fails when the raw request body is parsed as JSON before reaching the middleware. Pass the raw Buffer to stripe.webhooks.constructEvent. Check src/webhooks/stripe.ts for the correct implementation pattern.",
      errorMessage:
        "StripeSignatureVerificationError: No signatures found matching the expected signature for payload at src/webhooks/stripe.ts:34:18",
    },
    {
      title: "Prisma payment record unique constraint violation",
      content:
        "Payment record insertion throws P2002 unique constraint when retrying an idempotent webhook. Store idempotency key before inserting and check for existing record first. See src/api/payments.ts for the idempotent upsert pattern.",
      errorMessage:
        "PrismaClientKnownRequestError P2002: Unique constraint failed on the fields: users_payment_idempotency_key at src/api/payments.ts:97:22",
    },
    {
      title: "Stripe customer not found during charge",
      content:
        "Stripe raises StripeInvalidRequestError when charging a deleted customer. Always check customer status before initiating a charge. Soft-delete customers in the local DB and check before calling stripe.charges.create.",
      errorMessage:
        "StripeInvalidRequestError: No such customer: cus_DELETED at src/api/payments.ts:55:10",
    },
  ];

  // ── Dev B fixture data — auth/JWT/session ─────────────────────────────
  const devBErrors = [
    {
      title: "JWT invalid signature in auth middleware",
      content:
        "JWT verification fails with JsonWebTokenError when the token was signed with a different secret. Ensure AUTH_SECRET is consistent across deployments. Check src/auth/middleware.ts for secret loading logic — it must read from environment at request time, not at module load.",
      errorMessage:
        "JsonWebTokenError: invalid signature at src/auth/middleware.ts:33:14",
    },
    {
      title: "CORS preflight blocked on auth endpoints",
      content:
        "OPTIONS preflight requests to /api/auth/* return 405 when the CORS middleware is mounted after the route handler. Mount cors() before all routes in src/api/auth.ts. Always test with Fetch API from a different origin.",
      errorMessage:
        "Error: Access to fetch at blocked by CORS policy: No Access-Control-Allow-Origin header is present at src/api/auth.ts:12:5",
    },
    {
      title: "Session cookie not set on cross-origin requests",
      content:
        "Session cookie missing on cross-origin calls because SameSite defaults to Lax. Set sameSite: none and secure: true when the frontend is on a different domain. Update cookie options in src/auth/middleware.ts.",
      errorMessage:
        "Error: Set-Cookie header rejected — SameSite=None requires Secure attribute at src/auth/middleware.ts:78:20",
    },
  ];

  // ── Dev C fixture data — Postgres pool / Prisma migrations ───────────
  const devCErrors = [
    {
      title: "Postgres connection pool exhausted under load",
      content:
        "PG connection pool hits max connections during traffic spikes. Set pool_max to 20 in src/db/pool.ts and add connection_timeout. Use pgBouncer in transaction mode for read-heavy workloads. Monitor pool_waiting_count.",
      errorMessage:
        "Error: remaining connection slots are reserved for non-replication superuser connections at src/db/pool.ts:18:12",
    },
    {
      title: "Prisma migration fails on production due to lock timeout",
      content:
        "Long-running Prisma migrations on large tables cause lock timeouts in production. Use --create-only to generate SQL, then run with statement_timeout and lock_timeout set. Never run prisma migrate deploy without a maintenance window for tables over 1M rows.",
      errorMessage:
        "PrismaClientKnownRequestError: ERROR: canceling statement due to lock timeout at src/db/prisma.ts:44:9",
    },
    {
      title: "Prisma P1001 — server unreachable during startup",
      content:
        "Prisma throws P1001 when the database is not reachable at startup. Add a readiness check in src/db/pool.ts that retries with exponential backoff for up to 30 seconds before failing the process. Never crash immediately on first connection failure.",
      errorMessage:
        "PrismaClientInitializationError P1001: Can't reach database server at localhost:5432 at src/db/prisma.ts:22:15",
    },
  ];

  test("3 devs run 20 ops each in parallel — 30 entries persisted", async () => {
    await Promise.all([
      runDevSession(
        0,
        "payments",
        ["src/webhooks/stripe.ts", "src/api/payments.ts"],
        ["stripe", "payments", "webhook", "prisma"],
        ["stripe webhook signature verification", "payment idempotency prisma", "stripe customer charge"],
        devAErrors,
      ),
      runDevSession(
        1,
        "auth",
        ["src/auth/middleware.ts", "src/api/auth.ts"],
        ["jwt", "auth", "cors", "session"],
        ["jwt token invalid signature middleware", "cors preflight auth", "session cookie cross origin"],
        devBErrors,
      ),
      runDevSession(
        2,
        "data",
        ["src/db/pool.ts", "src/db/prisma.ts"],
        ["postgres", "prisma", "migration", "connection"],
        ["postgres connection pool exhausted", "prisma migration lock timeout", "database unreachable startup"],
        devCErrors,
      ),
    ]);

    const { cnt } = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM entries")
      .get()!;
    expect(cnt).toBe(30);
  });

  test("activity log captures all 60 logged events (10 learn + 5 recall + 5 extra per dev)", () => {
    // Each dev logs: 10 learn + 5 recall + 5 extra = 20 events
    // 3 devs × 20 = 60
    const activity = getRecentActivity(db, teamId, 24 * 7);
    expect(activity.length).toBe(60);
  });

  test("Dev A (payments) finds own stripe webhook entry via BM25", () => {
    const devId = devIds[0];
    const results = searchByBM25(db, "stripe webhook signature verification", undefined, devId);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    // Must hit at least one of Dev A's entries
    const devAIds = Array.from({ length: 10 }, (_, j) => `dev-0-entry-${j}`);
    const found = ids.some((id) => devAIds.includes(id));
    expect(found).toBe(true);
  });

  test("Dev B (auth) finds own JWT middleware entry via BM25", () => {
    const devId = devIds[1];
    const results = searchByBM25(db, "jwt token invalid signature", undefined, devId);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    const devBIds = Array.from({ length: 10 }, (_, j) => `dev-1-entry-${j}`);
    const found = ids.some((id) => devBIds.includes(id));
    expect(found).toBe(true);
  });

  test("Dev C (data layer) finds own postgres pool entry via BM25", () => {
    const devId = devIds[2];
    const results = searchByBM25(db, "postgres connection pool exhausted", undefined, devId);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    const devCIds = Array.from({ length: 10 }, (_, j) => `dev-2-entry-${j}`);
    const found = ids.some((id) => devCIds.includes(id));
    expect(found).toBe(true);
  });

  test("cross-dev visibility — Dev A can find Dev B's auth entry via team-scoped BM25", () => {
    // Insert a distinctive auth entry as Dev B
    const devBId = devIds[1];
    const crossEntry: EntryRow = {
      id: "cross-dev-auth-sentinel",
      type: "convention",
      title: "Auth middleware always validates Bearer token expiry before handler",
      content:
        "Every protected route must call validateBearerToken in src/auth/middleware.ts before the handler runs. JWT tokens expire after 900 seconds. Refresh via POST /api/auth/refresh with the refresh token cookie.",
      files: ["src/auth/middleware.ts"],
      tags: ["auth", "bearer", "middleware", "jwt"],
      confidence: 0.9,
      sourceCount: 2,
      status: "active",
      scope: "team",
      developerId: devBId,
    };
    insertEntry(db, crossEntry);

    // Dev A searches — no developerId filter still matches team scope
    const devAId = devIds[0];
    const results = searchByBM25(db, "auth middleware bearer token expiry", undefined, devAId);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("cross-dev-auth-sentinel");
  });

  test("getRecentActivity returns all logged events within one week", () => {
    const activity = getRecentActivity(db, teamId, 24 * 7);
    // Must include all 3 developers
    const uniqueDevs = new Set(activity.map((a) => a.developerId));
    expect(uniqueDevs.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Simultaneous learn race deduplication
// ---------------------------------------------------------------------------

describe("Suite 2: simultaneous learn race deduplication", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  afterAll(() => {
    db.close();
  });

  /**
   * Raw Prisma P2002 errors at two different line:col positions.
   * After normalisation both should collapse to the same signature.
   */
  const RAW_ERROR_A =
    "Prisma P2002 Unique constraint failed on field: users_email_unique at src/api/users.ts:42:18";
  const RAW_ERROR_B =
    "Prisma P2002 Unique constraint failed on field: users_email_unique at src/api/users.ts:97:22";
  const UNRELATED_ERROR =
    "TypeError: Cannot read properties of undefined (reading 'map') at src/utils/transform.ts:15:6";

  test("exact same error message — duplicate detected after first insert", () => {
    const firstInput: LearnInput = {
      type: "error_pattern",
      title: "Prisma unique constraint on users email field",
      content:
        "Prisma P2002 is thrown when inserting a user with an email that already exists. Add a .findFirst check before insert or use upsert. Affected: src/api/users.ts.",
      files: ["src/api/users.ts"],
      tags: ["prisma", "unique-constraint", "p2002"],
      errorType: "PrismaClientKnownRequestError",
      errorMessage: RAW_ERROR_A,
      scope: "team",
    };

    const firstEntry = extractEntry(firstInput);
    insertEntry(db, {
      id: firstEntry.id,
      type: firstEntry.type,
      title: firstEntry.title,
      content: firstEntry.content,
      files: firstEntry.files,
      tags: firstEntry.tags,
      errorSignature: firstEntry.errorSignature,
      confidence: firstEntry.confidence,
      sourceCount: firstEntry.sourceCount,
      sourceTool: firstEntry.sourceTool,
      createdAt: firstEntry.createdAt,
      lastConfirmed: firstEntry.lastConfirmed,
      status: firstEntry.status,
      scope: firstEntry.scope,
    });

    // Second dev hits the exact same error — extractEntry produces same fingerprint
    const secondInput: LearnInput = {
      ...firstInput,
      errorMessage: RAW_ERROR_A,
    };
    const secondEntry = extractEntry(secondInput);

    const duplicateId = findDuplicate(db, secondEntry);
    expect(duplicateId).toBe(firstEntry.id);
  });

  test("same error at different line:col — normalisation collapses to same signature → duplicate detected", () => {
    // RAW_ERROR_A and RAW_ERROR_B differ only by line:col (42:18 vs 97:22).
    // normalizeErrorSignature replaces both with :<LINE>, so the resulting
    // fingerprint is identical and findDuplicate must return the first entry's id.

    // Retrieve the ID of the entry inserted in the previous test
    const existingRow = db
      .query<{ id: string }, []>("SELECT id FROM entries LIMIT 1")
      .get()!;

    const input: LearnInput = {
      type: "error_pattern",
      title: "Prisma unique constraint on users email field — second occurrence",
      content:
        "Second developer encountered the same Prisma P2002 constraint violation on the users table. Identical root cause and fix.",
      files: ["src/api/users.ts"],
      tags: ["prisma", "unique-constraint", "p2002"],
      errorType: "PrismaClientKnownRequestError",
      errorMessage: RAW_ERROR_B,
      scope: "team",
    };

    const entry = extractEntry(input);
    const duplicateId = findDuplicate(db, entry);

    // Both line-number variants normalise to the same signature, so we must
    // get back the ID of the first persisted entry.
    expect(duplicateId).toBe(existingRow.id);
  });

  test("completely different error — findDuplicate returns null", () => {
    const input: LearnInput = {
      type: "error_pattern",
      title: "TypeError undefined map in transform utility",
      content:
        "Transform utility crashes when the input array is undefined. Always guard with Array.isArray before calling .map. Affected: src/utils/transform.ts.",
      files: ["src/utils/transform.ts"],
      tags: ["typeerror", "undefined", "transform"],
      errorType: "TypeError",
      errorMessage: UNRELATED_ERROR,
      scope: "team",
    };

    const entry = extractEntry(input);
    const duplicateId = findDuplicate(db, entry);
    expect(duplicateId).toBeNull();
  });

  test("inserting second distinct error then checking dedup — no false positive", () => {
    // Insert the unrelated error
    const input: LearnInput = {
      type: "error_pattern",
      title: "TypeError undefined map in transform utility — persisted",
      content:
        "Confirmed TypeError from transform utility. Root cause: upstream API returns null instead of empty array. Fix: add null coalesce guard before map call.",
      files: ["src/utils/transform.ts"],
      tags: ["typeerror", "undefined", "transform", "null"],
      errorType: "TypeError",
      errorMessage: UNRELATED_ERROR,
      scope: "team",
    };

    const entry = extractEntry(input);
    insertEntry(db, {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      content: entry.content,
      files: entry.files,
      tags: entry.tags,
      errorSignature: entry.errorSignature,
      confidence: entry.confidence,
      sourceCount: entry.sourceCount,
      sourceTool: entry.sourceTool,
      createdAt: entry.createdAt,
      lastConfirmed: entry.lastConfirmed,
      status: entry.status,
      scope: entry.scope,
    });

    // Now the Prisma error (RAW_ERROR_A) must NOT match the TypeError entry
    const prismaInput: LearnInput = {
      type: "error_pattern",
      title: "Prisma unique constraint — third occurrence",
      content:
        "Third occurrence of the Prisma P2002 error. Same root cause and fix.",
      files: ["src/api/users.ts"],
      tags: ["prisma", "p2002", "unique-constraint"],
      errorType: "PrismaClientKnownRequestError",
      errorMessage: RAW_ERROR_A,
      scope: "team",
    };

    const prismaEntry = extractEntry(prismaInput);
    const duplicateId = findDuplicate(db, prismaEntry);

    // Must resolve to the Prisma entry, not the TypeError entry
    const typeErrorRow = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE error_signature LIKE ? LIMIT 1",
      )
      .get("%typeerror%");

    // duplicateId must be non-null (first prisma entry found) and must not
    // equal the TypeError entry id
    expect(duplicateId).not.toBeNull();
    if (typeErrorRow !== null) {
      expect(duplicateId).not.toBe(typeErrorRow.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — 500 read queries P50/P95 latency
// ---------------------------------------------------------------------------

describe("Suite 3: 500 read queries P50/P95 latency on 200-entry DB", () => {
  let db: Database;

  // 25 distinct queries covering all seeded domains — 20 iterations each = 500 total
  const BENCHMARK_QUERIES = [
    // postgres
    "postgres connection refused ECONNREFUSED pool",
    "postgresql server not accepting connections",
    "remaining connection slots reserved superuser",
    "connection pool exhausted timeout",
    // prisma
    "prisma unique constraint failed email",
    "PrismaClientKnownRequestError P2002 field",
    "prisma migration lock timeout production",
    "prisma P1001 database server unreachable startup",
    // stripe
    "stripe webhook signature verification error",
    "StripeInvalidRequestError no such customer",
    "stripe charge payment failed invalid request",
    "webhook constructEvent raw body buffer",
    // jwt
    "jwt invalid signature auth middleware",
    "JsonWebTokenError token tampered wrong secret",
    "session cookie SameSite none secure",
    "cors preflight blocked auth endpoint",
    // redis
    "redis WRONGTYPE operation wrong kind value",
    "ReplyError redis key type mismatch cache",
    // zod
    "ZodError invalid type string undefined email",
    "zod schema validation parse error",
    // cross-domain
    "error connection database pool",
    "authentication token middleware bearer",
    "validation schema input boundary",
    "payment transaction idempotency constraint",
    "migration deploy lock timeout database",
  ] as const;

  const latencies: number[] = [];

  beforeAll(() => {
    db = initDatabase(":memory:");

    // Seed 200 entries spread across 6 domains (~33 per domain with wrap-around)
    const domains = [...SEED_DOMAINS];
    for (let i = 0; i < 200; i++) {
      const domain = domains[i % domains.length]!;
      seedCodeEntry(db, i, domain);
    }
  });

  afterAll(() => {
    db.close();
  });

  // 500 BM25 queries with query expansion + FTS5 sanitisation collectively
  // exceed Bun's default 5s per-test timeout on a 200-entry DB. The P50/P95
  // thresholds (20ms / 100ms) are the real performance contracts; this budget
  // only covers the total wall-clock time needed to run all 500 queries.
  test("all 500 queries complete without throwing", () => {
    const errors: string[] = [];

    for (let iteration = 0; iteration < 20; iteration++) {
      for (const query of BENCHMARK_QUERIES) {
        const start = performance.now();
        try {
          searchByBM25(db, query);
        } catch (err) {
          errors.push(
            `Query "${query}" iteration ${iteration} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
      }
    }

    expect(errors).toHaveLength(0);
    expect(latencies).toHaveLength(500);
  }, { timeout: 30000 });

  test("all recorded latencies are non-negative", () => {
    const negative = latencies.filter((l) => l < 0);
    expect(negative).toHaveLength(0);
  });

  test("at least some queries return results (average return count > 0)", () => {
    let totalResults = 0;
    let queryCount = 0;

    for (const query of BENCHMARK_QUERIES) {
      const results = searchByBM25(db, query);
      totalResults += results.length;
      queryCount++;
    }

    const average = totalResults / queryCount;
    expect(average).toBeGreaterThan(0);
  });

  test("P50 (median) latency < 20ms on 200-entry in-memory DB", () => {
    const p50 = percentile(latencies, 50);
    // Report the actual value even if the assertion fails for diagnostic purposes
    console.info(`P50 latency: ${p50.toFixed(3)}ms`);
    expect(p50).toBeLessThan(20);
  });

  test("P95 latency < 100ms on 200-entry in-memory DB", () => {
    const p95 = percentile(latencies, 95);
    console.info(`P95 latency: ${p95.toFixed(3)}ms`);
    // 100ms threshold is conservative enough to pass on CI and developer machines.
    // The target is 50ms in steady state; if P95 lands between 50–100ms it is a
    // tuning signal rather than a correctness failure.
    expect(p95).toBeLessThan(100);
  });
});
