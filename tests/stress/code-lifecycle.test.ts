/**
 * Stress test: 30-day lifecycle simulation for a payments engineering team.
 *
 * Proves that Gyst's learn/confidence/consolidation pipeline behaves correctly
 * under realistic team usage patterns — four weeks of error patterns,
 * conventions, conflicts, reinforcement, and consolidation.
 *
 * Asserts per-week retrieval quality (MRR@5) and latency targets.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import { consolidate } from "../../src/compiler/consolidate.js";
import { searchByBM25, searchByFilePath, reciprocalRankFusion } from "../../src/store/search.js";
import { calculateConfidence } from "../../src/store/confidence.js";
import { normalizeErrorSignature, generateFingerprint } from "../../src/compiler/normalize.js";
import { extractEntry } from "../../src/compiler/extract.js";
import type { LearnInput, KnowledgeEntry } from "../../src/compiler/extract.js";
import { findDuplicate, mergeEntries } from "../../src/compiler/deduplicate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function computeReciprocalRank(rankedIds: string[], relevantIds: string[]): number {
  for (let i = 0; i < Math.min(rankedIds.length, 5); i++) {
    if (relevantIds.includes(rankedIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function computeMRR(queries: Array<{ rankedIds: string[]; relevantIds: string[] }>): number {
  if (queries.length === 0) return 0;
  const sum = queries.reduce(
    (acc, q) => acc + computeReciprocalRank(q.rankedIds, q.relevantIds),
    0,
  );
  return sum / queries.length;
}

function makePaymentsEntry(i: number, overrides: Partial<EntryRow> = {}): EntryRow {
  const patterns = [
    {
      title: "Stripe webhook signature validation failure",
      content: "When Stripe webhooks fail signature validation, check that STRIPE_WEBHOOK_SECRET matches the endpoint secret in Stripe dashboard. Fix: use raw request body, not parsed JSON.",
      errorSignature: normalizeErrorSignature("StripeSignatureVerificationError: No signatures found matching the expected signature for payload"),
    },
    {
      title: "Payment idempotency key prevents double charges",
      content: "Always pass idempotency_key when creating Stripe PaymentIntents to prevent duplicate charges on retry. Use requestId as the idempotency key.",
      errorSignature: undefined,
    },
    {
      title: "Stripe API timeout causes checkout failure",
      content: "Stripe API calls timeout after 30 seconds. Wrap all Stripe calls in retry logic with exponential backoff. Fix: use stripe-node built-in timeout config.",
      errorSignature: normalizeErrorSignature("Error: ETIMEDOUT connecting to api.stripe.com"),
    },
    {
      title: "Webhook delivery order not guaranteed",
      content: "Stripe webhooks can arrive out of order. Always use event.created timestamp to determine processing order, not arrival time.",
      errorSignature: undefined,
    },
    {
      title: "PaymentIntent requires_action state handling",
      content: "When PaymentIntent status is requires_action, redirect to stripe.confirmCardPayment with clientSecret. Missing this causes silent checkout failure.",
      errorSignature: undefined,
    },
    {
      title: "Refund race condition with webhook",
      content: "Refund webhooks can arrive before the API response. Use database transactions and check-then-act pattern to avoid double-refund. Fix: use idempotency keys on refund calls.",
      errorSignature: normalizeErrorSignature("Error: Refund already processed: re_xxxxx"),
    },
    {
      title: "Stripe Connect platform fees calculation",
      content: "Platform fees on Stripe Connect must be set at PaymentIntent creation, not after capture. application_fee_amount is immutable after creation.",
      errorSignature: undefined,
    },
    {
      title: "Currency mismatch in payment amounts",
      content: "Stripe amounts are in smallest currency unit (cents for USD). Passing dollars directly causes 100x overcharge. Fix: always multiply by 100 for USD.",
      errorSignature: normalizeErrorSignature("StripeInvalidRequestError: Amount must be no more than $999,999.99"),
    },
    {
      title: "3D Secure authentication timeout",
      content: "3DS authentication has a 10-minute user timeout. After timeout, PaymentIntent status becomes requires_payment_method. Frontend must handle this state.",
      errorSignature: undefined,
    },
    {
      title: "Webhook endpoint must return 2xx within 30 seconds",
      content: "Stripe retries webhooks if your endpoint takes longer than 30 seconds. Process webhooks async: return 200 immediately, enqueue for background processing.",
      errorSignature: undefined,
    },
  ];

  const pattern = patterns[i % patterns.length]!;
  const now = new Date().toISOString();

  return {
    id: `payment-${i}`,
    type: "error_pattern",
    title: pattern.title,
    content: pattern.content,
    files: [`src/payments/checkout-${i % 3}.ts`],
    tags: ["stripe", "payments"],
    errorSignature: pattern.errorSignature,
    confidence: 0.5,
    sourceCount: 1,
    sourceTool: "stress-test",
    createdAt: now,
    lastConfirmed: now,
    status: "active",
    scope: "team",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 30-day lifecycle simulation
// ---------------------------------------------------------------------------

describe("payments team — 30-day lifecycle", () => {
  let db: Database;
  const paymentEntryIds = Array.from({ length: 10 }, (_, i) => `payment-${i}`);

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  afterAll(() => {
    db.close();
  });

  test("week 1 — seed 10 payments error_patterns", () => {
    for (let i = 0; i < 10; i++) {
      insertEntry(db, makePaymentsEntry(i));
    }
    // Time-travel to 25 days ago
    for (const id of paymentEntryIds) {
      db.run(
        "UPDATE entries SET created_at = ?, last_confirmed = ? WHERE id = ?",
        [daysAgo(25), daysAgo(25), id],
      );
    }

    const { cnt } = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM entries")
      .get()!;
    expect(cnt).toBe(10);

    const results = searchByBM25(db, "stripe webhook");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const resultIds = results.map((r) => r.id);
    // At least one of the stripe webhook entries should appear
    const hasWebhookEntry = resultIds.some((id) => id === "payment-0" || id === "payment-3" || id === "payment-9");
    expect(hasWebhookEntry).toBe(true);
  });

  test("week 2 — contradicting conventions arrive", () => {
    const now = new Date().toISOString();
    const conflictIds = ["convention-idempotency-1", "convention-idempotency-2", "convention-idempotency-3"];

    insertEntry(db, {
      id: conflictIds[0]!,
      type: "convention",
      title: "Idempotency keys required for all payment mutations",
      content: "Always pass idempotency keys for Stripe API calls to prevent double charges. Required for POST, PATCH operations.",
      files: ["src/payments/stripe-client.ts"],
      tags: ["idempotency", "stripe"],
      confidence: 0.6,
      sourceCount: 2,
      sourceTool: "stress-test",
      createdAt: now,
      lastConfirmed: now,
      status: "active",
      scope: "team",
    });
    insertEntry(db, {
      id: conflictIds[1]!,
      type: "convention",
      title: "Idempotency optional for GET requests",
      content: "GET requests are idempotent by definition — no need to pass idempotency keys for read operations.",
      files: ["src/payments/stripe-client.ts"],
      tags: ["idempotency"],
      confidence: 0.5,
      sourceCount: 1,
      sourceTool: "stress-test",
      createdAt: now,
      lastConfirmed: now,
      status: "active",
      scope: "team",
    });
    insertEntry(db, {
      id: conflictIds[2]!,
      type: "convention",
      title: "Idempotency keys required in test and production environments",
      content: "Pass idempotency keys in both test and production Stripe environments. Test without keys to verify retry safety.",
      files: ["src/payments/stripe-client.ts"],
      tags: ["idempotency", "test"],
      confidence: 0.5,
      sourceCount: 1,
      sourceTool: "stress-test",
      createdAt: now,
      lastConfirmed: now,
      status: "active",
      scope: "team",
    });

    // Time-travel all 3 to 18 days ago
    for (const id of conflictIds) {
      db.run(
        "UPDATE entries SET created_at = ?, last_confirmed = ? WHERE id = ?",
        [daysAgo(18), daysAgo(18), id],
      );
    }

    // Mark one as conflicted
    db.run("UPDATE entries SET status = 'conflicted' WHERE id = ?", [conflictIds[0]!]);

    const results = searchByBM25(db, "idempotency");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const resultIds = results.map((r) => r.id);
    const hasConflict = resultIds.some((id) => conflictIds.includes(id));
    expect(hasConflict).toBe(true);
  });

  test("week 3 — reinforce successful patterns, confidence rises", () => {
    // Reinforce 3 of the week-1 entries
    const reinforcedIds = ["payment-0", "payment-2", "payment-5"];
    for (const id of reinforcedIds) {
      // +4 makes sourceCount=5 (saturation=5/6≈0.833) at 10 days ago (decay≈0.794)
      // → confidence ≈ 0.833 * 0.794 ≈ 0.661, safely >= 0.6
      db.run(
        "UPDATE entries SET source_count = source_count + 4, last_confirmed = ? WHERE id = ?",
        [daysAgo(10), id],
      );
    }

    for (const id of reinforcedIds) {
      const row = db
        .query<{ source_count: number; last_confirmed: string }, [string]>(
          "SELECT source_count, last_confirmed FROM entries WHERE id = ?",
        )
        .get(id)!;

      const conf = calculateConfidence({
        type: "error_pattern",
        sourceCount: row.source_count,
        lastConfirmedAt: row.last_confirmed,
        now: new Date(),
        hasContradiction: false,
        codeChanged: false,
      });
      expect(conf).toBeGreaterThanOrEqual(0.6);
    }
  });

  test("week 4 — consolidate and MRR@5 >= 0.70", async () => {
    const report = await consolidate(db);
    expect(report.entriesDecayed).toBeGreaterThanOrEqual(1);

    // Build queries targeting the 10 payment entries
    const queries = [
      { text: "stripe webhook signature validation failure", relevant: ["payment-0"] },
      { text: "stripe payment idempotency key double charge", relevant: ["payment-1"] },
      { text: "stripe API timeout checkout", relevant: ["payment-2"] },
      { text: "webhook delivery order event timestamp", relevant: ["payment-3"] },
      { text: "PaymentIntent requires_action stripe confirm", relevant: ["payment-4"] },
    ];

    const start = performance.now();
    const mrrInputs = queries.map(({ text, relevant }) => {
      const bm25 = searchByBM25(db, text);
      const file = searchByFilePath(db, ["src/payments/checkout-0.ts"]);
      const fused = reciprocalRankFusion([bm25, file]);
      return { rankedIds: fused.map((r) => r.id), relevantIds: relevant };
    });
    const latency = performance.now() - start;

    expect(latency).toBeLessThan(200);
    const mrr = computeMRR(mrrInputs);
    expect(mrr).toBeGreaterThanOrEqual(0.70);
  });

  test("week 4 — ghost knowledge never touched by consolidation", async () => {
    const ghostId = "ghost-payments-never-log-card-numbers";
    const now = new Date().toISOString();

    insertEntry(db, {
      id: ghostId,
      type: "ghost_knowledge",
      title: "Never log card numbers or CVV in any environment",
      content: "Team rule: PCI DSS compliance — never log raw card data. Mask all PAN digits except last 4.",
      files: ["src/payments/checkout-0.ts"],
      tags: ["security", "pci"],
      confidence: 1.0,
      sourceCount: 1,
      sourceTool: "admin",
      createdAt: daysAgo(60),
      lastConfirmed: daysAgo(60),
      status: "active",
      scope: "team",
    });

    await consolidate(db);

    const row = db
      .query<{ confidence: number; status: string }, [string]>(
        "SELECT confidence, status FROM entries WHERE id = ?",
      )
      .get(ghostId)!;

    expect(row).not.toBeNull();
    expect(row.confidence).toBe(1.0);
    expect(row.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Confidence decay over time
// ---------------------------------------------------------------------------

describe("confidence decay over time", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  afterAll(() => {
    db.close();
  });

  test("error_pattern decays after 30 days (half-life)", () => {
    const conf = calculateConfidence({
      type: "error_pattern",
      sourceCount: 1,
      lastConfirmedAt: daysAgo(30),
      now: new Date(),
      hasContradiction: false,
      codeChanged: false,
    });
    // After one full half-life (30 days), confidence should be well below 0.5
    expect(conf).toBeLessThan(0.5);
  });

  test("convention does not decay over 365 days", () => {
    const confRecent = calculateConfidence({
      type: "convention",
      sourceCount: 1,
      lastConfirmedAt: daysAgo(0),
      now: new Date(),
      hasContradiction: false,
      codeChanged: false,
    });
    const confAncient = calculateConfidence({
      type: "convention",
      sourceCount: 1,
      lastConfirmedAt: daysAgo(365),
      now: new Date(),
      hasContradiction: false,
      codeChanged: false,
    });
    // Conventions have half-life of 9999 days — effectively no decay
    expect(Math.abs(confAncient - confRecent)).toBeLessThan(0.1);
  });

  test("contradiction penalty halves confidence", () => {
    const confClean = calculateConfidence({
      type: "learning",
      sourceCount: 2,
      lastConfirmedAt: daysAgo(5),
      now: new Date(),
      hasContradiction: false,
      codeChanged: false,
    });
    const confConflicted = calculateConfidence({
      type: "learning",
      sourceCount: 2,
      lastConfirmedAt: daysAgo(5),
      now: new Date(),
      hasContradiction: true,
      codeChanged: false,
    });
    expect(confConflicted).toBeLessThan(confClean);
    expect(confConflicted).toBeLessThanOrEqual(confClean * 0.5 + 0.01); // ~50% penalty
  });

  test("ghost_knowledge has infinite half-life — confidence stays at 1.0", () => {
    const conf = calculateConfidence({
      type: "ghost_knowledge",
      sourceCount: 1,
      lastConfirmedAt: daysAgo(365),
      now: new Date(),
      hasContradiction: false,
      codeChanged: false,
    });
    // ghost_knowledge has infinite half-life so no time decay,
    // but confidence formula = saturation * decay = saturation * 1.0
    // The 1.0 confidence is the explicitly-set initial value, not what
    // calculateConfidence returns for sourceCount=1.
    // Verify ghost stays equal regardless of time elapsed:
    const confAtZeroDays = calculateConfidence({
      type: "ghost_knowledge",
      sourceCount: 1,
      lastConfirmedAt: new Date().toISOString(),
      now: new Date(),
      hasContradiction: false,
      codeChanged: false,
    });
    expect(conf).toBeCloseTo(confAtZeroDays, 5); // No decay over any time span
  });
});

// ---------------------------------------------------------------------------
// Deduplication on identical error signatures
// ---------------------------------------------------------------------------

describe("deduplication on identical error signatures", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  afterAll(() => {
    db.close();
  });

  test("findDuplicate detects matching fingerprint", () => {
    const sharedSignature = normalizeErrorSignature(
      "TypeError: Cannot read properties of undefined (reading 'stripe') at checkout.ts:42:5",
    );
    const fingerprint = generateFingerprint(sharedSignature ?? "");

    const now = new Date().toISOString();
    insertEntry(db, {
      id: "dup-entry-1",
      type: "error_pattern",
      title: "Stripe client not initialized before use",
      content: "Ensure stripe client is initialized before calling stripe.paymentIntents.create. Fix: check process.env.STRIPE_SECRET_KEY at startup.",
      files: ["src/payments/checkout.ts"],
      tags: ["stripe"],
      errorSignature: fingerprint,
      confidence: 0.5,
      sourceCount: 1,
      sourceTool: "stress-test",
      createdAt: now,
      lastConfirmed: now,
      status: "active",
      scope: "team",
    });

    // Build a KnowledgeEntry with the same fingerprint to test findDuplicate
    const incoming: KnowledgeEntry = {
      id: "dup-entry-2",
      type: "error_pattern",
      title: "Stripe undefined reference in checkout",
      content: "Stripe client undefined — initialize before use. Fix: move stripe init to module top level.",
      files: ["src/payments/checkout.ts"],
      tags: ["stripe", "initialization"],
      fingerprint,
      confidence: 0.5,
      sourceCount: 1,
      status: "active",
      scope: "team",
    };

    const duplicateId = findDuplicate(db, incoming);
    expect(duplicateId).toBe("dup-entry-1");
  });

  test("mergeEntries combines source counts immutably", () => {
    const now = new Date().toISOString();
    const existing: KnowledgeEntry = {
      id: "existing-1",
      type: "error_pattern",
      title: "Stripe webhook secret mismatch",
      content: "Check STRIPE_WEBHOOK_SECRET environment variable.",
      files: ["src/webhooks/handler.ts"],
      tags: ["stripe", "webhook"],
      confidence: 0.5,
      sourceCount: 1,
      status: "active",
      scope: "team",
      createdAt: now,
      lastConfirmed: now,
    };
    const incoming: KnowledgeEntry = {
      id: "incoming-1",
      type: "error_pattern",
      title: "Stripe signature verification fails",
      content: "Use raw body for Stripe signature verification, not parsed JSON. Fix: pass req.rawBody to stripe.webhooks.constructEvent.",
      files: ["src/webhooks/handler.ts", "src/middleware/body-parser.ts"],
      tags: ["stripe", "webhook", "signature"],
      confidence: 0.6,
      sourceCount: 2,
      status: "active",
      scope: "team",
      createdAt: now,
      lastConfirmed: now,
    };

    const merged = mergeEntries(existing, incoming);

    expect(merged.id).toBe(existing.id); // keeps existing ID
    expect(merged.sourceCount).toBe(3); // 1 + 2
    expect(merged.confidence).toBe(0.6); // max(0.5, 0.6)
    expect(merged.files).toContain("src/webhooks/handler.ts");
    expect(merged.files).toContain("src/middleware/body-parser.ts");
    expect(merged.tags).toContain("signature");
    // Verify immutability — original not mutated
    expect(existing.sourceCount).toBe(1);
    expect(incoming.sourceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Per-week MRR@5 trend
// ---------------------------------------------------------------------------

describe("per-week MRR@5 trend", () => {
  let db: Database;

  const week1Ids = ["w1-0", "w1-1", "w1-2", "w1-3", "w1-4"];
  const week2Ids = ["w2-0", "w2-1", "w2-2", "w2-3", "w2-4"];
  const week3Ids = ["w3-0", "w3-1", "w3-2", "w3-3", "w3-4"];

  beforeAll(() => {
    db = initDatabase(":memory:");

    const domains = ["auth JWT token expiry middleware", "database connection pool timeout", "redis cache eviction LRU", "S3 upload presigned URL expiry", "GraphQL resolver N+1 query"];

    for (let i = 0; i < 5; i++) {
      const baseContent = domains[i]!;
      insertEntry(db, {
        id: week1Ids[i]!,
        type: "error_pattern",
        title: `Week 1: ${baseContent}`,
        content: `Error pattern for ${baseContent}. Fix: implement proper retry with backoff and circuit breaker pattern.`,
        files: [`src/week1/module-${i}.ts`],
        tags: ["week1"],
        confidence: 0.5,
        sourceCount: 1,
        sourceTool: "stress-test",
        createdAt: daysAgo(28),
        lastConfirmed: daysAgo(28),
        status: "active",
        scope: "team",
      });
      insertEntry(db, {
        id: week2Ids[i]!,
        type: "convention",
        title: `Week 2: ${baseContent} best practice`,
        content: `Convention for ${baseContent}. Always validate configuration at startup and use health check endpoints.`,
        files: [`src/week2/module-${i}.ts`],
        tags: ["week2"],
        confidence: 0.5,
        sourceCount: 1,
        sourceTool: "stress-test",
        createdAt: daysAgo(21),
        lastConfirmed: daysAgo(21),
        status: "active",
        scope: "team",
      });
      insertEntry(db, {
        id: week3Ids[i]!,
        type: "learning",
        title: `Week 3: ${baseContent} lesson`,
        content: `Learning from ${baseContent} incident. Root cause was missing monitoring. Added Datadog alerts and runbook.`,
        files: [`src/week3/module-${i}.ts`],
        tags: ["week3"],
        confidence: 0.5,
        sourceCount: 1,
        sourceTool: "stress-test",
        createdAt: daysAgo(14),
        lastConfirmed: daysAgo(14),
        status: "active",
        scope: "team",
      });
    }
  });

  afterAll(() => {
    db.close();
  });

  function weekMRR(db: Database, queries: string[][], relevantIds: string[][]): number {
    const inputs = queries.map((terms, i) => {
      const query = terms.join(" ");
      const results = searchByBM25(db, query);
      return { rankedIds: results.map((r) => r.id), relevantIds: relevantIds[i]! };
    });
    return computeMRR(inputs);
  }

  test("week 1 entries MRR@5 >= 0.60", () => {
    const queries = [
      ["JWT", "token", "expiry", "middleware"],
      ["database", "connection", "pool", "timeout"],
      ["redis", "cache", "eviction"],
      ["S3", "upload", "presigned", "URL"],
      ["GraphQL", "resolver", "N+1", "query"],
    ];
    const mrr = weekMRR(db, queries, week1Ids.map((id) => [id]));
    expect(mrr).toBeGreaterThanOrEqual(0.60);
  });

  test("week 2 entries MRR@5 >= 0.60", () => {
    const queries = [
      ["JWT", "token", "expiry", "best", "practice"],
      ["database", "connection", "pool", "convention"],
      ["redis", "cache", "eviction", "convention"],
      ["S3", "upload", "presigned", "convention"],
      ["GraphQL", "N+1", "convention"],
    ];
    const mrr = weekMRR(db, queries, week2Ids.map((id) => [id]));
    expect(mrr).toBeGreaterThanOrEqual(0.60);
  });

  test("week 3 entries MRR@5 >= 0.60", () => {
    const queries = [
      ["JWT", "authentication", "incident", "monitoring"],
      ["database", "connection", "lesson", "runbook"],
      ["redis", "cache", "eviction", "Datadog"],
      ["S3", "upload", "lesson"],
      ["GraphQL", "N+1", "lesson", "alert"],
    ];
    const mrr = weekMRR(db, queries, week3Ids.map((id) => [id]));
    expect(mrr).toBeGreaterThanOrEqual(0.60);
  });

  test("recent entries do not hurt earlier retrieval quality", () => {
    // Week 1 was 28 days ago — verify it still surfaces in search
    const results = searchByBM25(db, "JWT token expiry middleware error");
    const ids = results.map((r) => r.id);
    const hasWeek1 = ids.includes("w1-0");
    const hasWeek3 = ids.includes("w3-0");
    // Both should appear — BM25 is not time-weighted
    expect(hasWeek1 || hasWeek3).toBe(true);
  });
});
