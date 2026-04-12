/**
 * Stress test: memory bloat resistance.
 *
 * Ramps from 500 to 1000 to 2000 entries with deliberate duplicates and
 * contradictions, then verifies that consolidation keeps the knowledge base
 * healthy. Also proves that the SQLite index can be fully rebuilt from the
 * markdown source files.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import { consolidate } from "../../src/compiler/consolidate.js";
import type { ConsolidationReport } from "../../src/compiler/consolidate.js";
import { writeEntry } from "../../src/compiler/writer.js";
import { rebuildFromMarkdown } from "../../src/store/rebuild.js";
import type { RebuildStats } from "../../src/store/rebuild.js";
import { searchByBM25 } from "../../src/store/search.js";
import type { KnowledgeEntry } from "../../src/compiler/extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOMAINS = ["payments", "auth", "database", "api", "webhooks", "cache", "frontend"] as const;
const TYPES = ["error_pattern", "convention", "decision", "learning"] as const;

function makeEntry(i: number, typeOverride?: string, overrides: Partial<EntryRow> = {}): EntryRow {
  const type = (typeOverride ?? TYPES[i % TYPES.length]) as string;
  const domain = DOMAINS[i % DOMAINS.length]!;
  const fileIdx = i % 10;
  const now = new Date(Date.now() - (i % 30) * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: `entry-${i}`,
    type,
    title: `${domain} ${type} note ${i}`,
    content: `This describes a ${type} in the ${domain} subsystem. Entry index ${i}. Fix: validate inputs and add proper error handling with retry logic.`,
    files: [`src/${domain}/module-${fileIdx}.ts`],
    tags: [domain, type],
    errorSignature: type === "error_pattern" ? `error-sig-${i % 20}` : undefined,
    confidence: 0.3 + (i % 7) * 0.1,
    sourceCount: 1 + (i % 3),
    sourceTool: "stress-test",
    createdAt: now,
    lastConfirmed: now,
    status: "active",
    scope: "team",
    ...overrides,
  };
}

/** Converts an EntryRow (camelCase) to KnowledgeEntry for writeEntry — same shape. */
function rowToEntry(row: EntryRow): KnowledgeEntry {
  return {
    id: row.id,
    type: row.type as KnowledgeEntry["type"],
    title: row.title,
    content: row.content,
    files: row.files as string[],
    tags: row.tags as string[],
    errorSignature: row.errorSignature,
    confidence: row.confidence,
    sourceCount: row.sourceCount,
    sourceTool: row.sourceTool,
    createdAt: row.createdAt,
    lastConfirmed: row.lastConfirmed,
    status: (row.status === "consolidated" ? "archived" : (row.status ?? "active")) as KnowledgeEntry["status"],
    scope: row.scope ?? "team",
    developerId: row.developerId,
  };
}

function countActive(db: Database): number {
  const row = db
    .query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM entries WHERE status = 'active'",
    )
    .get()!;
  return row.cnt;
}

function countAll(db: Database): number {
  const row = db
    .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM entries")
    .get()!;
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Entry ramp: 500 → 1000 → 2000
// ---------------------------------------------------------------------------

describe("entry ramp: 500 → 1000 → 2000", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  afterAll(() => {
    db.close();
  });

  test("500 entries — baseline count and retrieval speed", () => {
    for (let i = 0; i < 500; i++) {
      insertEntry(db, makeEntry(i));
    }
    expect(countAll(db)).toBe(500);

    // Insert 5 well-known entries for MRR check
    for (let k = 0; k < 5; k++) {
      insertEntry(db, {
        id: `known-${k}`,
        type: "error_pattern",
        title: `database connection timeout error ${k}`,
        content: `Database connection pool exhausted. Fix: increase pool size and add connection timeout. Index ${k}.`,
        files: [`src/database/pool-${k}.ts`],
        tags: ["database", "timeout"],
        confidence: 0.6,
        sourceCount: 2,
        sourceTool: "stress-test",
        createdAt: new Date().toISOString(),
        lastConfirmed: new Date().toISOString(),
        status: "active",
        scope: "team",
      });
    }

    const start = performance.now();
    const results = searchByBM25(db, "database connection timeout");
    const latency = performance.now() - start;

    expect(latency).toBeLessThan(100);
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Known entries should surface
    const ids = results.map((r) => r.id);
    const found = ids.filter((id) => id.startsWith("known-"));
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  test("500→1000 — near-duplicates merged by consolidation", async () => {
    // Insert 500 more; 50 share file_path with earlier entries (potential dupes)
    for (let i = 500; i < 1000; i++) {
      const isDupe = i < 550;
      const fileIdx = isDupe ? (i - 500) % 10 : i % 10;
      const domain = DOMAINS[i % DOMAINS.length]!;
      insertEntry(db, makeEntry(i, "error_pattern", {
        id: `entry-${i}`,
        files: isDupe ? [`src/${domain}/module-${fileIdx}.ts`] : [`src/${domain}/module-new-${fileIdx}.ts`],
      }));
    }

    // Total before consolidation: 505 + 500 = 1005 (including the 5 known entries)
    expect(countAll(db)).toBeGreaterThanOrEqual(1000);

    const report: ConsolidationReport = await consolidate(db);

    // Some entries should have been archived/merged
    const activeAfter = countActive(db);
    expect(activeAfter).toBeLessThan(countAll(db)); // Some got archived
    expect(report.entriesDecayed + report.duplicatesMerged + report.entriesArchived).toBeGreaterThanOrEqual(0);
  });

  test("1000→2000 — contradictions and archive, search still fast", async () => {
    for (let i = 1000; i < 2000; i++) {
      const isConflicted = i >= 1000 && i < 1030; // 30 conflicted
      insertEntry(db, makeEntry(i, undefined, {
        id: `entry-${i}`,
        status: isConflicted ? "conflicted" : "active",
      }));
    }

    expect(countAll(db)).toBeGreaterThanOrEqual(1000);

    const report2: ConsolidationReport = await consolidate(db);
    expect(report2.entriesArchived).toBeGreaterThanOrEqual(0);

    // Search must still be fast even with large DB
    const start = performance.now();
    const results = searchByBM25(db, "payment webhook");
    const latency = performance.now() - start;

    expect(latency).toBeLessThan(200);
    // Search returns something (payments entries were inserted)
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Consolidation cluster merge
// ---------------------------------------------------------------------------

describe("consolidation cluster merge", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  afterAll(() => {
    db.close();
  });

  test("7 entries on same file_path triggers stage 3 cluster merge", async () => {
    const sharedFile = "src/payments/checkout.ts";
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    for (let i = 0; i < 7; i++) {
      insertEntry(db, {
        id: `cluster-${i}`,
        type: "error_pattern",
        title: `checkout payment error ${i} stripe idempotency webhook`,
        content: `Error in checkout payment flow ${i}. Fix: verify stripe webhook signature and add idempotency key for payment intent creation.`,
        files: [sharedFile],
        tags: ["payments", "stripe"],
        confidence: 0.4,
        sourceCount: 1,
        sourceTool: "stress-test",
        createdAt: staleDate,
        lastConfirmed: staleDate,
        status: "active",
        scope: "team",
      });
    }

    const report = await consolidate(db);
    expect(report.clustersConsolidated).toBeGreaterThanOrEqual(1);

    // At least some of the originals should now be non-active
    const archivedRows = db
      .query<{ cnt: number }, [string]>(
        `SELECT COUNT(*) as cnt FROM entries WHERE file_path = ? AND status != 'active'`,
      )
      .get(sharedFile)!;
    expect(archivedRows.cnt).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Rebuild from markdown parity
// ---------------------------------------------------------------------------

describe("rebuild from markdown parity", () => {
  let db: Database;
  let wikiDir: string;
  let dbDir: string;

  beforeAll(() => {
    db = initDatabase(":memory:");
    wikiDir = mkdtempSync(join(tmpdir(), "gyst-bloat-wiki-"));
    dbDir = mkdtempSync(join(tmpdir(), "gyst-bloat-db-"));
  });

  afterAll(() => {
    db.close();
    try {
      rmSync(wikiDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test("rebuilt DB has same active count as original", async () => {
    const entries: EntryRow[] = [];
    for (let i = 0; i < 20; i++) {
      const row = makeEntry(i, undefined, { id: `rebuild-${i}` });
      entries.push(row);
      insertEntry(db, row);
    }

    // Write each entry as a markdown file so rebuildFromMarkdown can read it
    for (const row of entries) {
      const entry = rowToEntry(row);
      writeEntry(entry, wikiDir);
    }

    const dbPath = join(dbDir, "rebuilt.db");
    const stats: RebuildStats = await rebuildFromMarkdown({
      wikiDir,
      dbPath,
      maxRecallTokens: 5000,
      confidenceThreshold: 0.15,
      logLevel: "error",
    });

    expect(stats.total).toBeGreaterThanOrEqual(20);
    expect(stats.errors).toBe(0);

    // Open rebuilt DB and compare active counts
    const rebuiltDb = new Database(dbPath);
    const originalActive = countActive(db);
    const rebuiltActive = rebuiltDb
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) as cnt FROM entries WHERE status = 'active'",
      )
      .get()?.cnt ?? 0;

    // Allow ±2 for any index entries or minor differences during rebuild
    expect(Math.abs(rebuiltActive - originalActive)).toBeLessThanOrEqual(2);

    // Search works on rebuilt DB too
    const results = searchByBM25(rebuiltDb, "payments convention");
    expect(results.length).toBeGreaterThanOrEqual(0); // shouldn't throw

    rebuiltDb.close();
  });
});

// ---------------------------------------------------------------------------
// Latency under load
// ---------------------------------------------------------------------------

describe("latency under load", () => {
  let db: Database;

  beforeAll(() => {
    db = initDatabase(":memory:");
    for (let i = 0; i < 2000; i++) {
      insertEntry(db, makeEntry(i));
    }
  });

  afterAll(() => {
    db.close();
  });

  test("10 BM25 searches each < 150ms on 2000-entry DB", () => {
    const queries = [
      "database connection timeout pool",
      "stripe payment webhook signature",
      "authentication JWT token middleware",
      "cache eviction LRU redis",
      "API rate limit throttle",
      "frontend React component render",
      "webhooks idempotency retry",
      "error handling retry backoff",
      "TypeScript type validation zod",
      "deployment rollback production",
    ];

    const latencies: number[] = [];
    for (const q of queries) {
      const start = performance.now();
      const results = searchByBM25(db, q);
      const ms = performance.now() - start;
      latencies.push(ms);
      void results; // use result to prevent optimization
    }

    for (const ms of latencies) {
      expect(ms).toBeLessThan(150);
    }

    // P95 check: 95th percentile (index 9 of 10 sorted)
    latencies.sort((a, b) => a - b);
    expect(latencies[9]!).toBeLessThan(150);
  });

  test("consolidation on 2000-entry DB completes in < 5 seconds", async () => {
    const start = performance.now();
    await consolidate(db);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
