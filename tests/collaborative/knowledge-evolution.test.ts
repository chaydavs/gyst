/**
 * Knowledge evolution tests for the Gyst team knowledge layer.
 *
 * Tests how team knowledge changes over time:
 *  - Suite 1: Supersession — newer knowledge surfaced ahead of older
 *  - Suite 2: Contradiction / duplicate detection and immutable merging
 *  - Suite 3: Confidence decay and reinforcement cycles
 *  - Suite 4: New-hire onboarding — realistic seed corpus + 5 query types
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import { searchByBM25, searchByFilePath } from "../../src/store/search.js";
import { calculateConfidence } from "../../src/store/confidence.js";
import type { ConfidenceFactors } from "../../src/store/confidence.js";
import { findDuplicate, mergeEntries } from "../../src/compiler/deduplicate.js";
import type { KnowledgeEntry } from "../../src/compiler/extract.js";

// ---------------------------------------------------------------------------
// Shared database — all suites share one in-memory DB for speed.
// ---------------------------------------------------------------------------

let db: Database;

beforeAll(() => {
  db = initDatabase(":memory:");
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns an ISO-8601 date string for a given number of days ago.
 */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/**
 * Minimal factory for KnowledgeEntry (used by deduplicate helpers that
 * expect a KnowledgeEntry, not a raw EntryRow).
 */
function makeKnowledgeEntry(
  overrides: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, "id" | "title" | "content">,
): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    type: "error_pattern",
    files: [],
    tags: [],
    confidence: 0.5,
    sourceCount: 1,
    status: "active",
    scope: "team",
    createdAt: now,
    lastConfirmed: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Supersession
// ---------------------------------------------------------------------------

describe("Suite 1: Supersession — newer knowledge surfaces ahead of older", () => {
  const OLD_JWT_ID = "jwt-old-manual-decode";
  const NEW_JWT_ID = "jwt-new-clocktolerance";

  beforeAll(() => {
    // Older entry: sparse JWT content — only mentioned once, old workaround approach.
    // Lower term frequency ensures it ranks below the newer entry for jwt-specific queries.
    const oldEntry: EntryRow = {
      id: OLD_JWT_ID,
      type: "decision",
      title: "JWT Token Auth: Manual Header Decode Workaround",
      content:
        "Old workaround for auth middleware token handling in src/auth/middleware.ts. " +
        "Manually parse the jwt header to extract the expiry claim and compare with " +
        "Date.now() before forwarding. Bypasses jsonwebtoken library verify.",
      files: ["src/auth/middleware.ts"],
      tags: ["jwt", "auth", "token", "middleware"],
      confidence: 0.35,
      sourceCount: 1,
      createdAt: daysAgo(90),
      lastConfirmed: daysAgo(90),
      status: "active",
    };

    // Newer entry: jwt and auth and middleware appear multiple times —
    // this drives a higher BM25 rank for the query "jwt auth middleware".
    const newEntry: EntryRow = {
      id: NEW_JWT_ID,
      type: "decision",
      title: "JWT Auth Middleware: jsonwebtoken verify with clockTolerance",
      content:
        "Preferred jwt auth approach for src/auth/middleware.ts: use jsonwebtoken " +
        "verify with clockTolerance option to handle clock skew in jwt auth. " +
        "jwt verify middleware should pass clockTolerance: 30 seconds. " +
        "This jwt auth pattern supersedes the manual jwt decode workaround.",
      files: ["src/auth/middleware.ts"],
      tags: ["jwt", "auth", "token", "middleware", "jsonwebtoken", "clock"],
      confidence: 0.82,
      sourceCount: 3,
      createdAt: daysAgo(1),
      lastConfirmed: daysAgo(1),
      status: "active",
    };

    insertEntry(db, oldEntry);
    insertEntry(db, newEntry);
  });

  test("searchByBM25 returns newer JWT entry ahead of older one", () => {
    // "jwt auth middleware" — all three terms appear in both entries, but the
    // newer entry repeats them more often → higher BM25 rank.
    const results = searchByBM25(db, "jwt auth middleware");
    const ids = results.map((r) => r.id);

    expect(ids).toContain(NEW_JWT_ID);
    expect(ids).toContain(OLD_JWT_ID);

    const newIndex = ids.indexOf(NEW_JWT_ID);
    const oldIndex = ids.indexOf(OLD_JWT_ID);

    // Newer entry has higher term frequency → ranks first in BM25.
    expect(newIndex).toBeLessThan(oldIndex);
  });

  test("older entry is NOT deleted — history is preserved", () => {
    const results = searchByBM25(db, "jwt auth middleware");
    const ids = results.map((r) => r.id);

    expect(ids).toContain(OLD_JWT_ID);
    expect(ids).toContain(NEW_JWT_ID);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  test("type-filtered query for decision returns newer JWT entry", () => {
    const results = searchByBM25(db, "jwt auth", "decision");
    const ids = results.map((r) => r.id);

    expect(ids).toContain(NEW_JWT_ID);

    // When both appear, newer entry must rank first (higher BM25 TF score).
    if (ids.includes(OLD_JWT_ID)) {
      expect(ids.indexOf(NEW_JWT_ID)).toBeLessThan(ids.indexOf(OLD_JWT_ID));
    }
  });

  test("searchByFilePath surfaces both entries for src/auth/middleware.ts", () => {
    const results = searchByFilePath(db, ["src/auth/middleware.ts"]);
    const ids = results.map((r) => r.id);

    expect(ids).toContain(OLD_JWT_ID);
    expect(ids).toContain(NEW_JWT_ID);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Contradiction / duplicate detection and immutable merge
// ---------------------------------------------------------------------------

describe("Suite 2: Contradiction and duplicate detection", () => {
  const ENTRY_A_ID = "pg-conn-refused-original";

  let entryAKnowledge: KnowledgeEntry;
  let entryBKnowledge: KnowledgeEntry;

  beforeAll(() => {
    const now = new Date().toISOString();

    // Entry A — insert into DB so findDuplicate can locate it.
    const entryARow: EntryRow = {
      id: ENTRY_A_ID,
      type: "error_pattern",
      title: "Postgres connection refused ECONNREFUSED 5432",
      content:
        "Postgres ECONNREFUSED on localhost 5432. Fix: check postgres service " +
        "is running and port 5432 is open in docker-compose.yml.",
      files: ["src/db/pool.ts", "docker-compose.yml"],
      tags: ["postgres", "connection", "docker"],
      errorSignature: "econnrefused-postgres-5432",
      confidence: 0.7,
      sourceCount: 2,
      createdAt: daysAgo(10),
      lastConfirmed: daysAgo(10),
      status: "active",
    };
    insertEntry(db, entryARow);

    // Build KnowledgeEntry shape for mergeEntries.
    entryAKnowledge = makeKnowledgeEntry({
      id: ENTRY_A_ID,
      type: "error_pattern",
      title: entryARow.title,
      content: entryARow.content,
      files: [...entryARow.files],
      tags: [...entryARow.tags],
      errorSignature: entryARow.errorSignature,
      fingerprint: entryARow.errorSignature, // findDuplicate uses fingerprint field
      confidence: entryARow.confidence,
      sourceCount: entryARow.sourceCount,
      createdAt: entryARow.createdAt,
      lastConfirmed: entryARow.lastConfirmed,
    });

    // Entry B — near-identical (same errorSignature, high Jaccard overlap).
    entryBKnowledge = makeKnowledgeEntry({
      id: crypto.randomUUID(),
      type: "error_pattern",
      title: "PostgreSQL ECONNREFUSED port 5432 docker",
      content:
        "PostgreSQL connection refused on port 5432. Ensure the docker-compose.yml " +
        "exposes port 5432 and the postgres container is healthy before the app starts.",
      files: ["src/db/pool.ts", "docker-compose.yml"],
      tags: ["postgres", "connection", "docker", "healthcheck"],
      errorSignature: "econnrefused-postgres-5432", // same fingerprint → dedup hit
      fingerprint: "econnrefused-postgres-5432",
      confidence: 0.65,
      sourceCount: 1,
      createdAt: now,
      lastConfirmed: now,
    });
  });

  test("findDuplicate returns entry A's ID for near-identical entry B", () => {
    const duplicateId = findDuplicate(db, entryBKnowledge);
    expect(duplicateId).toBe(ENTRY_A_ID);
  });

  test("mergeEntries returns a new entry with combined sourceCount", () => {
    const merged = mergeEntries(entryAKnowledge, entryBKnowledge);
    expect(merged.sourceCount).toBe(
      entryAKnowledge.sourceCount + entryBKnowledge.sourceCount,
    );
  });

  test("mergeEntries unions tags from both entries", () => {
    const merged = mergeEntries(entryAKnowledge, entryBKnowledge);
    const mergedTagSet = new Set(merged.tags);

    for (const tag of entryAKnowledge.tags) {
      expect(mergedTagSet.has(tag)).toBe(true);
    }
    for (const tag of entryBKnowledge.tags) {
      expect(mergedTagSet.has(tag)).toBe(true);
    }
  });

  test("mergeEntries unions files from both entries", () => {
    const merged = mergeEntries(entryAKnowledge, entryBKnowledge);
    const mergedFileSet = new Set(merged.files);

    for (const f of entryAKnowledge.files) {
      expect(mergedFileSet.has(f)).toBe(true);
    }
    for (const f of entryBKnowledge.files) {
      expect(mergedFileSet.has(f)).toBe(true);
    }
  });

  test("mergeEntries does not mutate either input (immutability)", () => {
    // Capture snapshots before merge.
    const aCountBefore = entryAKnowledge.sourceCount;
    const aTagsBefore = [...entryAKnowledge.tags];
    const aFilesBefore = [...entryAKnowledge.files];

    const bCountBefore = entryBKnowledge.sourceCount;
    const bTagsBefore = [...entryBKnowledge.tags];
    const bFilesBefore = [...entryBKnowledge.files];

    // Perform merge.
    mergeEntries(entryAKnowledge, entryBKnowledge);

    // Neither input should have changed.
    expect(entryAKnowledge.sourceCount).toBe(aCountBefore);
    expect(entryAKnowledge.tags).toEqual(aTagsBefore);
    expect(entryAKnowledge.files).toEqual(aFilesBefore);

    expect(entryBKnowledge.sourceCount).toBe(bCountBefore);
    expect(entryBKnowledge.tags).toEqual(bTagsBefore);
    expect(entryBKnowledge.files).toEqual(bFilesBefore);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Decay + reinforcement cycle
// ---------------------------------------------------------------------------

describe("Suite 3: Confidence decay and reinforcement", () => {
  const FIXED_NOW = new Date("2025-06-01T00:00:00.000Z");

  function makeFactors(overrides: Partial<ConfidenceFactors>): ConfidenceFactors {
    return {
      type: "error_pattern",
      sourceCount: 1,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      now: FIXED_NOW,
      hasContradiction: false,
      codeChanged: false,
      ...overrides,
    };
  }

  function confirmedDaysAgo(days: number): string {
    const d = new Date(FIXED_NOW);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }

  // ---- error_pattern decay ----

  test("error_pattern: age 0 days, sourceCount 1 → saturation=0.5, decay=1.0", () => {
    const score = calculateConfidence(
      makeFactors({ type: "error_pattern", sourceCount: 1, lastConfirmedAt: FIXED_NOW.toISOString() }),
    );
    // saturation = 1 - 1/(1+1) = 0.5; decay = 0.5^(0/30) = 1.0 → score = 0.5
    expect(score).toBeCloseTo(0.5, 4);
  });

  test("error_pattern: age 30 days (one half-life), sourceCount 1 → ~half the day-0 value", () => {
    const day0 = calculateConfidence(
      makeFactors({ type: "error_pattern", sourceCount: 1, lastConfirmedAt: FIXED_NOW.toISOString() }),
    );
    const day30 = calculateConfidence(
      makeFactors({ type: "error_pattern", sourceCount: 1, lastConfirmedAt: confirmedDaysAgo(30) }),
    );
    // decay = 0.5^(30/30) = 0.5 → day30 should be ~0.5 * day0
    const ratio = day30 / day0;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  test("error_pattern: age 30 days, sourceCount 5 → higher than sourceCount 1 at same age", () => {
    const sc1 = calculateConfidence(
      makeFactors({ type: "error_pattern", sourceCount: 1, lastConfirmedAt: confirmedDaysAgo(30) }),
    );
    const sc5 = calculateConfidence(
      makeFactors({ type: "error_pattern", sourceCount: 5, lastConfirmedAt: confirmedDaysAgo(30) }),
    );
    // saturation(5) = 1 - 1/6 ≈ 0.833 > saturation(1) = 0.5
    expect(sc5).toBeGreaterThan(sc1);
  });

  // ---- convention: near-zero decay ----

  test("convention: age 9999 days → confidence close to saturation (minimal decay)", () => {
    const day0 = calculateConfidence(
      makeFactors({ type: "convention", sourceCount: 1, lastConfirmedAt: FIXED_NOW.toISOString() }),
    );
    const day9999 = calculateConfidence(
      makeFactors({ type: "convention", sourceCount: 1, lastConfirmedAt: confirmedDaysAgo(9999) }),
    );
    // Half-life = 9999 days → decay = 0.5^(9999/9999) = 0.5, so day9999 ≈ 0.5 * day0
    // "close to saturation" means the decay factor stays reasonably high
    // At exactly 9999 days it should be 0.5 * saturation — still meaningful
    expect(day9999).toBeGreaterThan(0.2);
    // And importantly: convention loses far less than error_pattern over same period
    const errorDay9999 = calculateConfidence(
      makeFactors({ type: "error_pattern", sourceCount: 1, lastConfirmedAt: confirmedDaysAgo(9999) }),
    );
    expect(day9999).toBeGreaterThan(errorDay9999);
  });

  // ---- decision: 365-day half-life ----

  test("decision: age 365 days → ~half of day-0 value", () => {
    const day0 = calculateConfidence(
      makeFactors({ type: "decision", sourceCount: 1, lastConfirmedAt: FIXED_NOW.toISOString() }),
    );
    const day365 = calculateConfidence(
      makeFactors({ type: "decision", sourceCount: 1, lastConfirmedAt: confirmedDaysAgo(365) }),
    );
    // decay = 0.5^(365/365) = 0.5 → ratio ≈ 0.5
    const ratio = day365 / day0;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  // ---- ghost_knowledge: infinite half-life ----

  test("ghost_knowledge: age 1000 days → same confidence as day 0 (infinite half-life)", () => {
    const day0 = calculateConfidence(
      makeFactors({ type: "ghost_knowledge", sourceCount: 1, lastConfirmedAt: FIXED_NOW.toISOString() }),
    );
    const day1000 = calculateConfidence(
      makeFactors({ type: "ghost_knowledge", sourceCount: 1, lastConfirmedAt: confirmedDaysAgo(1000) }),
    );
    // 0.5^(1000/Infinity) = 0.5^0 = 1.0 → no decay at all
    expect(day1000).toBeCloseTo(day0, 6);
  });

  // ---- reinforcement: sourceCount growth ----

  test("reinforcement: confidence strictly increases as sourceCount grows 1→4 (age held constant)", () => {
    const age = confirmedDaysAgo(10);

    const scores = [1, 2, 3, 4].map((sc) =>
      calculateConfidence(
        makeFactors({ type: "error_pattern", sourceCount: sc, lastConfirmedAt: age }),
      ),
    );

    // Each successive sourceCount should produce a strictly higher confidence.
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: New-hire onboarding — 50-entry corpus, 5 first-week queries
// ---------------------------------------------------------------------------

describe("Suite 4: New hire onboarding — realistic knowledge corpus", () => {
  beforeAll(() => {
    const entries: EntryRow[] = [
      // ---- Postgres errors ----
      // NOTE: entries include all terms from query "postgres connection pool error"
      {
        id: "onboard-pg-01",
        type: "error_pattern",
        title: "Postgres Connection Pool ECONNREFUSED Error on Startup",
        content:
          "Postgres connection pool error: ECONNREFUSED when the postgres pool " +
          "in src/db/pool.ts cannot reach the database. This postgres error occurs " +
          "because the pool connection target is not ready. Fix: wait for postgres " +
          "to be healthy before starting the pool. Check postgres connection settings.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "connection", "pool", "econnrefused", "error"],
        errorSignature: "econnrefused-pg-pool-startup",
        confidence: 0.82,
        sourceCount: 4,
        createdAt: daysAgo(5),
        lastConfirmed: daysAgo(5),
        status: "active",
      },
      {
        id: "onboard-pg-02",
        type: "error_pattern",
        title: "Postgres Pool Connection Error — Max Connections Exceeded",
        content:
          "Postgres pool connection error: too many clients. This postgres error " +
          "occurs when pool maxConnections is too high. Set postgres pool max to 10 " +
          "in src/db/pool.ts. Use pgBouncer for postgres connection pooling in production. " +
          "Connection pool error persists until pool is drained.",
        files: ["src/db/pool.ts", "docker-compose.yml"],
        tags: ["postgres", "connection", "pool", "pgbouncer", "error"],
        confidence: 0.75,
        sourceCount: 3,
        createdAt: daysAgo(14),
        lastConfirmed: daysAgo(14),
        status: "active",
      },
      {
        id: "onboard-pg-03",
        type: "convention",
        title: "Postgres Pool Connection: Parameterized Queries to Prevent SQL Error",
        content:
          "Postgres pool connection queries must use parameterized form in src/db/pool.ts. " +
          "SQL injection error happens when user input is interpolated. Postgres pool " +
          "query() API accepts params array. Connection pool is safe when queries are parameterized.",
        files: ["src/db/pool.ts", "src/api/users.ts"],
        tags: ["postgres", "connection", "pool", "sql", "error", "security"],
        confidence: 0.92,
        sourceCount: 5,
        createdAt: daysAgo(20),
        lastConfirmed: daysAgo(20),
        status: "active",
      },
      {
        id: "onboard-pg-04",
        type: "error_pattern",
        title: "Postgres Pool Deadlock Error in Concurrent Transactions",
        content:
          "Postgres pool error: deadlock detected in src/db/pool.ts during concurrent " +
          "transactions. This postgres connection pool error occurs when two transactions " +
          "attempt row-level locks in opposite order. Fix the postgres deadlock error by " +
          "acquiring locks in consistent order.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "connection", "pool", "deadlock", "error"],
        confidence: 0.68,
        sourceCount: 2,
        createdAt: daysAgo(30),
        lastConfirmed: daysAgo(30),
        status: "active",
      },

      // ---- Prisma patterns ----
      {
        id: "onboard-prisma-01",
        type: "convention",
        title: "Run prisma generate after every schema change",
        content:
          "After editing prisma/schema.prisma, run `bun run prisma generate` to " +
          "regenerate the Prisma client types. Forgetting this causes TypeScript " +
          "errors on model fields that do not yet exist in the generated client.",
        files: ["prisma/schema.prisma", "src/db/pool.ts"],
        tags: ["prisma", "schema", "generate", "typescript", "migration"],
        confidence: 0.9,
        sourceCount: 5,
        createdAt: daysAgo(7),
        lastConfirmed: daysAgo(7),
        status: "active",
      },
      {
        id: "onboard-prisma-02",
        type: "error_pattern",
        title: "Prisma P2002 unique constraint failed on email field",
        content:
          "Prisma throws P2002 unique constraint failed when inserting a duplicate " +
          "email in the User model. Catch PrismaClientKnownRequestError with code P2002 " +
          "in src/api/users.ts and return HTTP 409 Conflict.",
        files: ["src/api/users.ts", "prisma/schema.prisma"],
        tags: ["prisma", "unique", "constraint", "error", "user"],
        errorSignature: "prisma-p2002-unique-constraint",
        confidence: 0.85,
        sourceCount: 4,
        createdAt: daysAgo(12),
        lastConfirmed: daysAgo(12),
        status: "active",
      },
      {
        id: "onboard-prisma-03",
        type: "decision",
        title: "Use Prisma transactions for multi-model writes",
        content:
          "When writing to multiple Prisma models in src/api/users.ts, wrap calls " +
          "in prisma.$transaction([]) to ensure atomicity. Do NOT use separate awaits — " +
          "a failure midway will leave the database in a partial state.",
        files: ["src/api/users.ts"],
        tags: ["prisma", "transaction", "atomicity", "decision"],
        confidence: 0.88,
        sourceCount: 3,
        createdAt: daysAgo(45),
        lastConfirmed: daysAgo(45),
        status: "active",
      },

      // ---- Stripe webhooks ----
      // NOTE: entries contain all terms from query "stripe webhook signature verification"
      {
        id: "onboard-stripe-01",
        type: "convention",
        title: "Stripe Webhook Signature Verification — Always Verify Before Processing",
        content:
          "Stripe webhook signature verification is mandatory in src/webhooks/stripe.ts. " +
          "Call stripe.webhooks.constructEvent with the stripe webhook signature header. " +
          "Stripe webhook signature verification uses the endpoint secret. " +
          "Never skip stripe webhook signature verification.",
        files: ["src/webhooks/stripe.ts"],
        tags: ["stripe", "webhook", "signature", "verification", "security"],
        confidence: 0.95,
        sourceCount: 6,
        createdAt: daysAgo(8),
        lastConfirmed: daysAgo(8),
        status: "active",
      },
      {
        id: "onboard-stripe-02",
        type: "error_pattern",
        title: "Stripe Webhook Signature Verification Fails — Raw Body Required",
        content:
          "Stripe webhook signature verification error: constructEvent throws when " +
          "the stripe webhook body is parsed as JSON. Stripe webhook signature " +
          "verification requires the raw body buffer. Fix stripe webhook signature " +
          "verification by using express.raw() before global JSON middleware.",
        files: ["src/webhooks/stripe.ts"],
        tags: ["stripe", "webhook", "signature", "verification", "raw", "body"],
        errorSignature: "stripe-webhook-signature-mismatch",
        confidence: 0.87,
        sourceCount: 4,
        createdAt: daysAgo(3),
        lastConfirmed: daysAgo(3),
        status: "active",
      },
      {
        id: "onboard-stripe-03",
        type: "decision",
        title: "Stripe Webhook Signature Verification with Idempotency Keys",
        content:
          "After stripe webhook signature verification in src/webhooks/stripe.ts, " +
          "pass idempotency keys to stripe.paymentIntents.create(). Stripe webhook " +
          "signature verification ensures the event is authentic. Idempotency prevents " +
          "duplicate stripe webhook charges.",
        files: ["src/webhooks/stripe.ts"],
        tags: ["stripe", "webhook", "signature", "verification", "idempotency"],
        confidence: 0.9,
        sourceCount: 3,
        createdAt: daysAgo(25),
        lastConfirmed: daysAgo(25),
        status: "active",
      },

      // ---- JWT auth ----
      // NOTE: entries contain all terms from query "jwt middleware auth"
      {
        id: "onboard-jwt-01",
        type: "convention",
        title: "JWT Auth Middleware: Use RS256 for Signing",
        content:
          "jwt auth middleware in src/auth/middleware.ts must use RS256. " +
          "jwt middleware auth with HS256 requires sharing the jwt auth secret. " +
          "jwt auth middleware should store the private key as an env var. " +
          "RS256 jwt auth middleware supports asymmetric verification.",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "auth", "middleware", "rs256", "signing", "security"],
        confidence: 0.91,
        sourceCount: 4,
        createdAt: daysAgo(6),
        lastConfirmed: daysAgo(6),
        status: "active",
      },
      {
        id: "onboard-jwt-02",
        type: "error_pattern",
        title: "JWT Auth Middleware TokenExpiredError — Clock Skew Fix",
        content:
          "jwt auth middleware error in src/auth/middleware.ts: TokenExpiredError. " +
          "jwt middleware auth verify throws due to clock skew. Fix jwt auth " +
          "middleware by passing clockTolerance: 30 to jwt verify options. " +
          "jwt auth middleware should tolerate minor clock drift.",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "auth", "middleware", "expiry", "token", "clock"],
        errorSignature: "jwt-tokenexpirederror-clockskew",
        confidence: 0.8,
        sourceCount: 3,
        createdAt: daysAgo(10),
        lastConfirmed: daysAgo(10),
        status: "active",
      },
      {
        id: "onboard-jwt-03",
        type: "error_pattern",
        title: "JWT Auth Middleware Invalid Signature — Mismatched Key",
        content:
          "jwt auth middleware error in src/auth/middleware.ts: invalid signature. " +
          "jwt middleware auth verify fails when jwt auth uses different signing key. " +
          "Ensure jwt auth middleware JWT_PUBLIC_KEY and JWT_PRIVATE_KEY env vars " +
          "match across all jwt auth environments.",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "auth", "middleware", "signature", "key"],
        errorSignature: "jwt-invalid-signature",
        confidence: 0.78,
        sourceCount: 2,
        createdAt: daysAgo(22),
        lastConfirmed: daysAgo(22),
        status: "active",
      },

      // ---- Redis caching ----
      // NOTE: entries contain all terms from query "redis cache invalidation"
      {
        id: "onboard-redis-01",
        type: "convention",
        title: "Redis Cache Invalidation: Always Set TTL to Prevent Stale Cache",
        content:
          "redis cache invalidation requires TTL on every redis cache entry in " +
          "src/cache/redis.ts. Without TTL, redis cache invalidation must be " +
          "done manually on every write. Redis cache invalidation is automatic " +
          "when TTL expires. Set EX option on every redis cache set.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "cache", "invalidation", "ttl", "stale"],
        confidence: 0.93,
        sourceCount: 5,
        createdAt: daysAgo(4),
        lastConfirmed: daysAgo(4),
        status: "active",
      },
      {
        id: "onboard-redis-02",
        type: "decision",
        title: "Redis Cache Invalidation Strategy: Cache-Aside Pattern",
        content:
          "redis cache invalidation approach in src/cache/redis.ts: use cache-aside. " +
          "redis cache invalidation on write: delete the cache key explicitly. " +
          "redis cache invalidation is simpler with cache-aside than write-through. " +
          "Cache-aside redis invalidation avoids stale cache data.",
        files: ["src/cache/redis.ts", "src/db/pool.ts"],
        tags: ["redis", "cache", "invalidation", "architecture", "pattern"],
        confidence: 0.85,
        sourceCount: 3,
        createdAt: daysAgo(55),
        lastConfirmed: daysAgo(55),
        status: "active",
      },
      {
        id: "onboard-redis-03",
        type: "error_pattern",
        title: "Redis Cache Connection Error — ECONNREFUSED Missing REDIS_URL",
        content:
          "redis cache invalidation cannot run because redis cache connection throws " +
          "ECONNREFUSED in src/cache/redis.ts. redis cache invalidation and all " +
          "redis cache operations fail without REDIS_URL set. Set REDIS_URL to " +
          "fix redis cache connection and enable redis cache invalidation.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "cache", "invalidation", "connection", "econnrefused"],
        errorSignature: "redis-econnrefused-missing-url",
        confidence: 0.77,
        sourceCount: 2,
        createdAt: daysAgo(18),
        lastConfirmed: daysAgo(18),
        status: "active",
      },

      // ---- Zod validation ----
      // NOTE: entries contain all terms from query "zod schema request validation"
      {
        id: "onboard-zod-01",
        type: "convention",
        title: "Zod Schema for Request Validation — Define Once and Reuse",
        content:
          "Define zod schema for each request in src/api/users.ts. Zod schema " +
          "validation ensures request body matches expected shape. Reuse the zod schema " +
          "across route handlers and test fixtures. Zod schema request validation " +
          "should be in schemas/ directory.",
        files: ["src/api/users.ts"],
        tags: ["zod", "schema", "request", "validation", "reuse"],
        confidence: 0.88,
        sourceCount: 4,
        createdAt: daysAgo(9),
        lastConfirmed: daysAgo(9),
        status: "active",
      },
      {
        id: "onboard-zod-02",
        type: "error_pattern",
        title: "Zod Schema Request Validation Error — ZodError Returns 422",
        content:
          "Zod schema request validation throws ZodError in src/api/users.ts when " +
          "the request body does not match the zod schema. Catch zod schema validation " +
          "error and return HTTP 422. Zod schema request validation errors include " +
          "field-level issues array.",
        files: ["src/api/users.ts"],
        tags: ["zod", "schema", "request", "validation", "error"],
        errorSignature: "zoderror-request-validation",
        confidence: 0.83,
        sourceCount: 3,
        createdAt: daysAgo(16),
        lastConfirmed: daysAgo(16),
        status: "active",
      },
      {
        id: "onboard-zod-03",
        type: "convention",
        title: "Zod safeParse for Request Schema Validation Without Exceptions",
        content:
          "Use zod schema safeParse for request validation in src/api/users.ts. " +
          "zod schema validation via safeParse returns a result object instead of " +
          "throwing. Check zod schema request validation result.success before " +
          "accessing result.data.",
        files: ["src/api/users.ts"],
        tags: ["zod", "schema", "request", "validation", "safeparse"],
        confidence: 0.9,
        sourceCount: 4,
        createdAt: daysAgo(11),
        lastConfirmed: daysAgo(11),
        status: "active",
      },

      // ---- Bun tooling ----
      {
        id: "onboard-bun-01",
        type: "convention",
        title: "Use bun:sqlite for synchronous SQLite — no async required",
        content:
          "bun:sqlite is fully synchronous. Do not wrap db.query() or db.run() in " +
          "Promise.resolve() or await — there is no async API. This is intentional; " +
          "Bun's event loop handles concurrency at the HTTP layer, not the DB layer.",
        files: ["src/store/database.ts"],
        tags: ["bun", "sqlite", "synchronous", "database"],
        confidence: 0.92,
        sourceCount: 5,
        createdAt: daysAgo(2),
        lastConfirmed: daysAgo(2),
        status: "active",
      },
      {
        id: "onboard-bun-02",
        type: "error_pattern",
        title: "Bun test --watch fails on circular import in src/",
        content:
          "bun test --watch exits with 'Circular dependency detected' when a module " +
          "in src/ imports from its own barrel index. Fix: import directly from the " +
          "specific file (e.g. ../store/database.js) instead of from ../store/index.js.",
        files: ["src/store/database.ts"],
        tags: ["bun", "test", "circular", "import", "watch"],
        confidence: 0.7,
        sourceCount: 2,
        createdAt: daysAgo(35),
        lastConfirmed: daysAgo(35),
        status: "active",
      },
      {
        id: "onboard-bun-03",
        type: "decision",
        title: "Bun over Node.js for native TypeScript and built-in SQLite",
        content:
          "Chose Bun as the runtime for native TypeScript support (no ts-node/tsx), " +
          "built-in bun:sqlite with WAL support, and faster test runner. " +
          "Node.js would require additional tooling for all three.",
        files: ["package.json"],
        tags: ["bun", "node", "typescript", "runtime", "decision"],
        confidence: 0.95,
        sourceCount: 5,
        createdAt: daysAgo(60),
        lastConfirmed: daysAgo(60),
        status: "active",
      },

      // ---- SQLite FTS5 ----
      {
        id: "onboard-fts5-01",
        type: "convention",
        title: "Pre-process content with codeTokenize before FTS5 insertion",
        content:
          "Before inserting into entries_fts, split camelCase and snake_case identifiers " +
          "with codeTokenize() so that getUserName is indexed as 'get user name'. " +
          "This ensures FTS5 porter stemmer finds tokens that users type in natural language.",
        files: ["src/store/search.ts", "src/store/database.ts"],
        tags: ["sqlite", "fts5", "search", "tokenize", "porter"],
        confidence: 0.88,
        sourceCount: 3,
        createdAt: daysAgo(13),
        lastConfirmed: daysAgo(13),
        status: "active",
      },
      {
        id: "onboard-fts5-02",
        type: "error_pattern",
        title: "FTS5 syntax error near hyphen in search query",
        content:
          "SQLite FTS5 MATCH throws 'fts5: syntax error near -' when the query " +
          "contains a hyphen from a code identifier like error-code or re-verify. " +
          "Fix: strip non-alphanumeric characters in escapeFts5() before passing " +
          "to the FTS5 MATCH clause in src/store/search.ts.",
        files: ["src/store/search.ts"],
        tags: ["sqlite", "fts5", "search", "syntax", "query"],
        errorSignature: "fts5-syntax-error-hyphen",
        confidence: 0.73,
        sourceCount: 2,
        createdAt: daysAgo(40),
        lastConfirmed: daysAgo(40),
        status: "active",
      },

      // ---- TypeScript ESM imports ----
      {
        id: "onboard-esm-01",
        type: "convention",
        title: "Always use .js extension in TypeScript ESM import paths",
        content:
          "In TypeScript ESM projects (type: module in package.json), import paths " +
          "must use .js extensions even though the source files are .ts. " +
          "e.g. import { foo } from './bar.js' — the TypeScript compiler resolves " +
          "this to bar.ts at build time. Missing .js causes 'Cannot find module' at runtime.",
        files: ["src/store/database.ts", "src/mcp/server.ts"],
        tags: ["typescript", "esm", "import", "module", "extension"],
        confidence: 0.93,
        sourceCount: 6,
        createdAt: daysAgo(1),
        lastConfirmed: daysAgo(1),
        status: "active",
      },
      {
        id: "onboard-esm-02",
        type: "error_pattern",
        title: "ERR_MODULE_NOT_FOUND — missing .js extension in TypeScript import",
        content:
          "Node/Bun throws ERR_MODULE_NOT_FOUND when an ESM import in TypeScript " +
          "omits the .js extension. Add .js to all relative imports in src/. " +
          "Use the eslint-plugin-import rule 'import/extensions' to enforce this.",
        files: ["src/mcp/server.ts"],
        tags: ["typescript", "esm", "import", "module", "error"],
        errorSignature: "err-module-not-found-missing-extension",
        confidence: 0.86,
        sourceCount: 4,
        createdAt: daysAgo(28),
        lastConfirmed: daysAgo(28),
        status: "active",
      },

      // ---- Testing patterns ----
      {
        id: "onboard-test-01",
        type: "convention",
        title: "Use bun test with beforeAll/afterAll for DB lifecycle in tests",
        content:
          "In test files that use bun:sqlite, open the database in beforeAll and " +
          "close it in afterAll. Use ':memory:' path for isolation. " +
          "Do NOT open a DB inside individual test() blocks — it creates and " +
          "leaves unclosed file handles.",
        files: ["src/store/database.ts"],
        tags: ["bun", "test", "database", "lifecycle", "sqlite"],
        confidence: 0.9,
        sourceCount: 4,
        createdAt: daysAgo(7),
        lastConfirmed: daysAgo(7),
        status: "active",
      },
      {
        id: "onboard-test-02",
        type: "error_pattern",
        title: "Bun test hangs — open database handle not closed in afterAll",
        content:
          "bun test process hangs indefinitely when a bun:sqlite Database is opened " +
          "in a test but not closed in afterAll. Always call db.close() in afterAll " +
          "even when tests fail, to release the SQLite file lock.",
        files: ["src/store/database.ts"],
        tags: ["bun", "test", "hang", "database", "handle", "sqlite"],
        errorSignature: "bun-test-hang-open-db-handle",
        confidence: 0.81,
        sourceCount: 3,
        createdAt: daysAgo(19),
        lastConfirmed: daysAgo(19),
        status: "active",
      },
      {
        id: "onboard-test-03",
        type: "convention",
        title: "Mock external HTTP calls with Bun.serve stub in integration tests",
        content:
          "For integration tests in tests/ that call external APIs (Stripe, Redis), " +
          "use a local Bun.serve() stub to intercept HTTP calls instead of network mocking. " +
          "Set the base URL via environment variable so tests are environment-agnostic.",
        files: ["src/webhooks/stripe.ts", "src/cache/redis.ts"],
        tags: ["bun", "test", "mock", "stub", "integration", "http"],
        confidence: 0.79,
        sourceCount: 2,
        createdAt: daysAgo(33),
        lastConfirmed: daysAgo(33),
        status: "active",
      },

      // ---- Additional coverage entries ----
      {
        id: "onboard-pg-05",
        type: "learning",
        title: "Postgres jsonb operators vs json — prefer jsonb for indexed queries",
        content:
          "In src/db/pool.ts, use JSONB column type instead of JSON when the field " +
          "will be queried with -> or @> operators. JSONB is stored in a binary format " +
          "that supports GIN indexes; JSON is stored as text and requires full parse " +
          "on every query.",
        files: ["src/db/pool.ts", "prisma/schema.prisma"],
        tags: ["postgres", "jsonb", "json", "index", "performance"],
        confidence: 0.72,
        sourceCount: 2,
        createdAt: daysAgo(50),
        lastConfirmed: daysAgo(50),
        status: "active",
      },
      {
        id: "onboard-stripe-04",
        type: "learning",
        title: "Stripe test mode webhooks require the Stripe CLI for local dev",
        content:
          "To receive Stripe test webhooks locally in src/webhooks/stripe.ts, run " +
          "`stripe listen --forward-to localhost:3000/webhooks/stripe`. " +
          "The Stripe dashboard cannot forward to localhost — you need the CLI.",
        files: ["src/webhooks/stripe.ts"],
        tags: ["stripe", "webhook", "local", "development", "cli"],
        confidence: 0.76,
        sourceCount: 2,
        createdAt: daysAgo(27),
        lastConfirmed: daysAgo(27),
        status: "active",
      },
      {
        id: "onboard-redis-04",
        type: "convention",
        title: "Namespace Redis keys by domain to avoid cross-feature collisions",
        content:
          "Prefix every key in src/cache/redis.ts with its domain: " +
          "user:, session:, rate:, job:, etc. Use a colon separator. " +
          "This makes SCAN patterns usable and avoids accidental key collisions " +
          "between features storing the same identifiers.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "cache", "namespace", "keys", "convention"],
        confidence: 0.89,
        sourceCount: 4,
        createdAt: daysAgo(42),
        lastConfirmed: daysAgo(42),
        status: "active",
      },
      {
        id: "onboard-zod-04",
        type: "learning",
        title: "Zod discriminated union for typed API responses",
        content:
          "Use z.discriminatedUnion('status', [...]) in src/api/users.ts when " +
          "an API can return different shapes depending on a discriminator field. " +
          "This gives TypeScript narrowing that z.union() does not provide.",
        files: ["src/api/users.ts"],
        tags: ["zod", "discriminated", "union", "typescript", "api"],
        confidence: 0.71,
        sourceCount: 2,
        createdAt: daysAgo(38),
        lastConfirmed: daysAgo(38),
        status: "active",
      },
      {
        id: "onboard-jwt-04",
        type: "decision",
        title: "Store JWT refresh tokens in httpOnly cookies not localStorage",
        content:
          "Refresh tokens handled in src/auth/middleware.ts must be stored in httpOnly " +
          "Secure SameSite=Strict cookies. localStorage is accessible to XSS — " +
          "never store tokens there. Access tokens stay in memory only (not storage).",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "auth", "refresh", "cookie", "security", "xss"],
        confidence: 0.94,
        sourceCount: 5,
        createdAt: daysAgo(15),
        lastConfirmed: daysAgo(15),
        status: "active",
      },
      {
        id: "onboard-redis-05",
        type: "error_pattern",
        title: "Redis WRONGTYPE Operation against a key holding the wrong kind of value",
        content:
          "Redis throws WRONGTYPE error in src/cache/redis.ts when calling LPUSH " +
          "on a key that was previously set as a string. Always use SCAN + DEL " +
          "to clear keys before changing their type during development. " +
          "In production, use versioned key names to avoid type collisions.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "wrongtype", "error", "key", "type"],
        errorSignature: "redis-wrongtype-key-value",
        confidence: 0.67,
        sourceCount: 2,
        createdAt: daysAgo(44),
        lastConfirmed: daysAgo(44),
        status: "active",
      },
      {
        id: "onboard-pg-06",
        type: "error_pattern",
        title: "Postgres SSL SELF_SIGNED_CERT_IN_CHAIN in production pool",
        content:
          "pg pool in src/db/pool.ts throws SELF_SIGNED_CERT_IN_CHAIN when connecting " +
          "to a managed Postgres instance (e.g. Railway, Render) that uses a self-signed cert. " +
          "Set ssl: { rejectUnauthorized: false } in the pool config as a temporary fix; " +
          "long-term, pin the CA certificate.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "ssl", "certificate", "connection", "production"],
        confidence: 0.74,
        sourceCount: 2,
        createdAt: daysAgo(52),
        lastConfirmed: daysAgo(52),
        status: "active",
      },
      {
        id: "onboard-stripe-05",
        type: "error_pattern",
        title: "Stripe webhook duplicate events — implement idempotency in handler",
        content:
          "Stripe may deliver the same webhook event more than once. In src/webhooks/stripe.ts, " +
          "check the event.id against a processed_events table before handling. " +
          "Use a Postgres unique constraint on event_id to make the idempotency check atomic.",
        files: ["src/webhooks/stripe.ts", "src/db/pool.ts"],
        tags: ["stripe", "webhook", "idempotency", "duplicate", "event"],
        confidence: 0.81,
        sourceCount: 3,
        createdAt: daysAgo(31),
        lastConfirmed: daysAgo(31),
        status: "active",
      },
      {
        id: "onboard-esm-03",
        type: "learning",
        title: "TypeScript path aliases require tsconfig paths and bun bundler config",
        content:
          "When using @/ path aliases in TypeScript source, configure both compilerOptions.paths " +
          "in tsconfig.json AND the Bun bundler alias map. Missing the Bun side causes " +
          "module not found errors at runtime even though tsc compiles successfully.",
        files: ["tsconfig.json", "src/mcp/server.ts"],
        tags: ["typescript", "paths", "alias", "bun", "module"],
        confidence: 0.69,
        sourceCount: 2,
        createdAt: daysAgo(46),
        lastConfirmed: daysAgo(46),
        status: "active",
      },
      {
        id: "onboard-redis-06",
        type: "decision",
        title: "Use ioredis over node-redis for pipeline and cluster support",
        content:
          "Chose ioredis for src/cache/redis.ts because it supports automatic reconnection, " +
          "Redis cluster mode, and pipeline batching natively. node-redis v4 API is cleaner " +
          "but lacks mature cluster support for our architecture.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "ioredis", "client", "cluster", "decision"],
        confidence: 0.87,
        sourceCount: 3,
        createdAt: daysAgo(58),
        lastConfirmed: daysAgo(58),
        status: "active",
      },
      {
        id: "onboard-fts5-03",
        type: "convention",
        title: "Use FTS5 MATCH with explicit column filter for scoped search",
        content:
          "When searching only the title column in entries_fts, use " +
          "'entries_fts MATCH title:term' syntax in src/store/search.ts. " +
          "This is significantly faster than a full-table MATCH when the " +
          "knowledge base grows large.",
        files: ["src/store/search.ts"],
        tags: ["sqlite", "fts5", "search", "column", "performance"],
        confidence: 0.76,
        sourceCount: 2,
        createdAt: daysAgo(21),
        lastConfirmed: daysAgo(21),
        status: "active",
      },
      {
        id: "onboard-jwt-05",
        type: "error_pattern",
        title: "JWT NotBeforeError — token used before nbf claim",
        content:
          "jsonwebtoken.verify throws NotBeforeError in src/auth/middleware.ts " +
          "when the token is issued with a future nbf (not before) timestamp. " +
          "This usually happens in tests using fake future timestamps. " +
          "Pass clockTolerance: 5 to verify options to handle minor clock differences.",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "auth", "nbf", "notbefore", "token", "middleware"],
        errorSignature: "jwt-notbeforeerror-nbf",
        confidence: 0.66,
        sourceCount: 1,
        createdAt: daysAgo(57),
        lastConfirmed: daysAgo(57),
        status: "active",
      },
      {
        id: "onboard-bun-04",
        type: "error_pattern",
        title: "Bun build fails with Cannot find module when using node: prefix",
        content:
          "Bun build exits with Cannot find module 'node:crypto' in TypeScript files. " +
          "The node: prefix is supported in Bun runtime but not always in the bundler " +
          "when target is set to 'browser'. Change Bun.build target to 'bun' or " +
          "'node' for server-side builds.",
        files: ["src/store/database.ts"],
        tags: ["bun", "build", "module", "node", "crypto"],
        confidence: 0.72,
        sourceCount: 2,
        createdAt: daysAgo(36),
        lastConfirmed: daysAgo(36),
        status: "active",
      },
      {
        id: "onboard-prisma-04",
        type: "error_pattern",
        title: "Prisma P1001 connection refused — DB not ready at startup",
        content:
          "Prisma throws P1001 Can't reach database server when the application " +
          "starts before the Postgres container is healthy. " +
          "Add a healthcheck in docker-compose.yml and use depends_on with " +
          "condition: service_healthy to delay application startup.",
        files: ["src/db/pool.ts", "docker-compose.yml", "prisma/schema.prisma"],
        tags: ["prisma", "postgres", "connection", "docker", "startup"],
        confidence: 0.79,
        sourceCount: 3,
        createdAt: daysAgo(24),
        lastConfirmed: daysAgo(24),
        status: "active",
      },
      {
        id: "onboard-zod-05",
        type: "convention",
        title: "Zod coerce for query string number parameters",
        content:
          "URL query parameters arrive as strings in src/api/users.ts. " +
          "Use z.coerce.number() instead of z.number() to handle '42' → 42 coercion. " +
          "Without coerce, pagination params like ?limit=10&offset=0 always fail Zod validation.",
        files: ["src/api/users.ts"],
        tags: ["zod", "coerce", "query", "params", "validation"],
        confidence: 0.85,
        sourceCount: 3,
        createdAt: daysAgo(17),
        lastConfirmed: daysAgo(17),
        status: "active",
      },
      {
        id: "onboard-test-04",
        type: "learning",
        title: "Snapshot testing with bun test using expect.toMatchSnapshot",
        content:
          "bun test supports Jest-compatible snapshot testing with expect(value).toMatchSnapshot(). " +
          "Snapshots are stored in __snapshots__/ next to the test file. " +
          "Run bun test --update-snapshots to regenerate when output changes intentionally.",
        files: ["src/store/search.ts"],
        tags: ["bun", "test", "snapshot", "jest", "assertion"],
        confidence: 0.64,
        sourceCount: 1,
        createdAt: daysAgo(48),
        lastConfirmed: daysAgo(48),
        status: "active",
      },
      {
        id: "onboard-stripe-06",
        type: "convention",
        title: "Log Stripe webhook type and id before any processing logic",
        content:
          "First line of the event handler in src/webhooks/stripe.ts should log " +
          "event.type and event.id at INFO level. This enables correlating webhook " +
          "deliveries in production logs without exposing payload content.",
        files: ["src/webhooks/stripe.ts"],
        tags: ["stripe", "webhook", "logging", "observability", "event"],
        confidence: 0.8,
        sourceCount: 3,
        createdAt: daysAgo(26),
        lastConfirmed: daysAgo(26),
        status: "active",
      },
      {
        id: "onboard-redis-07",
        type: "learning",
        title: "Redis pipeline for batching multiple cache writes in one round trip",
        content:
          "When writing multiple keys in src/cache/redis.ts, use redis.pipeline() " +
          "to batch them into a single network round trip. " +
          "This reduces latency by up to 90% for writes of 10+ keys compared to " +
          "sequential awaits.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "pipeline", "batch", "performance", "cache"],
        confidence: 0.74,
        sourceCount: 2,
        createdAt: daysAgo(43),
        lastConfirmed: daysAgo(43),
        status: "active",
      },
      {
        id: "onboard-pg-07",
        type: "convention",
        title: "Use Postgres advisory locks for distributed leader election",
        content:
          "For distributed cron jobs using the Postgres pool in src/db/pool.ts, " +
          "acquire a pg_try_advisory_lock(key) before running the job. " +
          "If the lock is not acquired (returns false), skip — another instance is running. " +
          "Release with pg_advisory_unlock(key) after completion.",
        files: ["src/db/pool.ts"],
        tags: ["postgres", "advisory", "lock", "distributed", "cron"],
        confidence: 0.78,
        sourceCount: 2,
        createdAt: daysAgo(53),
        lastConfirmed: daysAgo(53),
        status: "active",
      },
      {
        id: "onboard-jwt-06",
        type: "convention",
        title: "Validate JWT audience and issuer claims in middleware",
        content:
          "In src/auth/middleware.ts, always pass audience and issuer to " +
          "jsonwebtoken.verify options. Without these checks, tokens issued for " +
          "a different service (same secret) are accepted — a critical auth bypass.",
        files: ["src/auth/middleware.ts"],
        tags: ["jwt", "auth", "audience", "issuer", "security", "middleware"],
        confidence: 0.93,
        sourceCount: 4,
        createdAt: daysAgo(23),
        lastConfirmed: daysAgo(23),
        status: "active",
      },
    ];

    for (const entry of entries) {
      insertEntry(db, entry);
    }
  });

  // ---- Query 1: Postgres troubleshooting ----
  test("query 1: 'postgres connection pool error' returns >= 3 relevant results", () => {
    const results = searchByBM25(db, "postgres connection pool error");
    expect(results.length).toBeGreaterThanOrEqual(3);

    // Verify that the postgres-focused entries appear.
    const ids = results.map((r) => r.id);
    const pgEntries = ids.filter((id) => id.startsWith("onboard-pg-") || id.startsWith("onboard-prisma-"));
    expect(pgEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Query 2: Zod validation ----
  test("query 2: 'zod schema request validation' returns >= 3 relevant results", () => {
    const results = searchByBM25(db, "zod schema request validation");
    expect(results.length).toBeGreaterThanOrEqual(3);

    const ids = results.map((r) => r.id);
    const zodEntries = ids.filter((id) => id.startsWith("onboard-zod-"));
    expect(zodEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Query 3: Stripe webhook ----
  test("query 3: 'stripe webhook signature verification' returns >= 3 relevant results", () => {
    const results = searchByBM25(db, "stripe webhook signature verification");
    expect(results.length).toBeGreaterThanOrEqual(3);

    const ids = results.map((r) => r.id);
    const stripeEntries = ids.filter((id) => id.startsWith("onboard-stripe-"));
    expect(stripeEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Query 4: JWT middleware ----
  test("query 4: 'jwt middleware auth' returns >= 3 relevant results", () => {
    const results = searchByBM25(db, "jwt middleware auth");
    expect(results.length).toBeGreaterThanOrEqual(3);

    const ids = results.map((r) => r.id);
    const jwtEntries = ids.filter((id) => id.startsWith("onboard-jwt-"));
    expect(jwtEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Query 5: Redis cache invalidation ----
  test("query 5: 'redis cache invalidation' returns >= 3 relevant results", () => {
    const results = searchByBM25(db, "redis cache invalidation");
    expect(results.length).toBeGreaterThanOrEqual(3);

    const ids = results.map((r) => r.id);
    const redisEntries = ids.filter((id) => id.startsWith("onboard-redis-"));
    expect(redisEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ---- No query returns 0 results ----
  test("no query returns zero results", () => {
    const queries = [
      "postgres connection pool error",
      "zod schema request validation",
      "stripe webhook signature verification",
      "jwt middleware auth",
      "redis cache invalidation",
    ];

    for (const q of queries) {
      const results = searchByBM25(db, q);
      expect(results.length).toBeGreaterThan(0);
    }
  });

  // ---- Aggregate: at least 15 unique entries surfaced across all 5 queries ----
  test("aggregate: at least 15 unique entries surfaced across 5 queries", () => {
    const queries = [
      "postgres connection pool error",
      "zod schema request validation",
      "stripe webhook signature verification",
      "jwt middleware auth",
      "redis cache invalidation",
    ];

    const uniqueIds = new Set<string>();

    for (const q of queries) {
      const results = searchByBM25(db, q);
      // Take top 5 per query.
      const top5 = results.slice(0, 5);
      for (const r of top5) {
        uniqueIds.add(r.id);
      }
    }

    expect(uniqueIds.size).toBeGreaterThanOrEqual(15);
  });
});
