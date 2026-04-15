/**
 * SQLite concurrency tests.
 *
 * Two scenarios:
 *
 * 1. Multi-connection concurrent writes (realistic)
 *    Simulates 50 separate processes each opening their own Database
 *    connection and writing concurrently — the actual contention pattern
 *    when 50 `gyst-mcp` CLI invocations or HTTP requests run in parallel.
 *    WAL mode + busy_timeout = 5000ms (set by initDatabase on every
 *    connection) must absorb all contention; withRetry is the last resort.
 *    Repeated 3 times to catch flakiness.
 *
 * 2. WAL and busy_timeout verification
 *    Confirms initDatabase sets the correct pragmas on every new connection.
 *
 * 3. withRetry unit tests
 *    Verify the retry helper re-throws non-lock errors and succeeds on the
 *    second attempt after a transient "database is locked" error.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase, withRetry } from "../../src/store/database.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gyst-concurrency-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pragma verification
// ---------------------------------------------------------------------------

describe("initDatabase pragma verification", () => {
  test("WAL mode is set on every new connection", () => {
    const dbPath = join(tmpDir, "pragma-check.db");
    const db = initDatabase(dbPath);
    const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    db.close();
    expect(row?.journal_mode).toBe("wal");
  });

  test("busy_timeout is set to at least 5000ms on every new connection", () => {
    const dbPath = join(tmpDir, "pragma-check.db");
    const db = initDatabase(dbPath);
    const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
    db.close();
    expect(row?.timeout).toBeGreaterThanOrEqual(5000);
  });
});

// ---------------------------------------------------------------------------
// withRetry unit tests
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  test("re-throws non-lock errors immediately", () => {
    expect(() =>
      withRetry(() => {
        throw new Error("some unrelated database error");
      }),
    ).toThrow("some unrelated database error");
  });

  test("succeeds when fn passes on second attempt", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls += 1;
      if (calls === 1) throw new Error("database is locked");
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-connection concurrent writes — run 3 times to detect flakiness
// ---------------------------------------------------------------------------

for (let run = 1; run <= 3; run++) {
  describe(`multi-connection concurrent writes — run ${run}`, () => {
    test("50 separate connections all succeed with zero locked errors", async () => {
      const dbPath = join(tmpDir, `multi-conn-run-${run}.db`);

      // Initialise schema once on a primary connection.
      const primary = initDatabase(dbPath);
      primary.close();

      const WRITE_COUNT = 50;
      const lockedErrors: string[] = [];
      const otherErrors: string[] = [];

      // Each promise opens its OWN initDatabase connection — this is the
      // exact pattern of 50 separate `gyst-mcp` process invocations.
      const writes = Array.from({ length: WRITE_COUNT }, (_, i) =>
        (async () => {
          const conn = initDatabase(dbPath);
          try {
            conn
              .prepare(
                `INSERT INTO entries
                   (id, type, title, content, scope, status,
                    confidence, source_count, created_at, last_confirmed)
                 VALUES (?, 'learning', ?, ?, 'team', 'active',
                         0.8, 1, datetime('now'), datetime('now'))`,
              )
              .run(
                `run-${run}-entry-${i}`,
                `Concurrent test ${i}`,
                `Written by connection ${i}`,
              );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("database is locked")) {
              lockedErrors.push(msg);
            } else {
              otherErrors.push(msg);
            }
          } finally {
            conn.close();
          }
        })(),
      );

      await Promise.all(writes);

      // Verify durability via a fresh connection.
      const verify = initDatabase(dbPath);
      const stored = verify
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM entries WHERE id LIKE ?",
        )
        .get(`run-${run}-entry-%`);
      verify.close();

      expect(lockedErrors).toHaveLength(0);
      expect(otherErrors).toHaveLength(0);
      expect(stored?.n).toBe(WRITE_COUNT);
    });
  });
}
