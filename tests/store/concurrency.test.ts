/**
 * SQLite concurrency tests.
 *
 * Verifies that 50 concurrent write operations (via Promise.all) against the
 * same database file complete without "database is locked" errors and that
 * every entry is durably stored.
 *
 * The test is intentionally run 3 times to catch flakiness — all three runs
 * must pass.
 *
 * Architecture note: bun:sqlite is synchronous, so Promise.all executes the
 * individual insertEntry calls sequentially on the JS event loop but from a
 * single shared Database instance (the same contention pattern as concurrent
 * HTTP requests in team mode). True multi-process concurrency is protected by
 * WAL mode + busy_timeout = 5000ms set in initDatabase().
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase, insertEntry, withRetry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, tag: string): EntryRow {
  return {
    id,
    type: "learning",
    title: `Concurrency test: ${id}`,
    content: `Written during concurrent write test (tag: ${tag})`,
    files: [],
    tags: ["concurrency-test", tag],
    confidence: 0.8,
    sourceCount: 1,
    sourceTool: "test",
  };
}

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
// Run the same scenario 3 times to detect flakiness
// ---------------------------------------------------------------------------

for (let run = 1; run <= 3; run++) {
  describe(`SQLite concurrency — run ${run}`, () => {
    test("50 concurrent writes all succeed with zero locked errors", async () => {
      const dbPath = join(tmpDir, `run-${run}.db`);
      const db = initDatabase(dbPath);

      const lockedErrors: string[] = [];
      const otherErrors: string[] = [];
      const WRITE_COUNT = 50;

      // Launch 50 write operations "concurrently" via Promise.all.
      // bun:sqlite executes them synchronously, but this is the same
      // contention model as concurrent requests sharing one DB connection.
      const writes = Array.from({ length: WRITE_COUNT }, (_, i) =>
        Promise.resolve().then(() => {
          try {
            insertEntry(db, makeEntry(`run-${run}-entry-${i}`, `run-${run}`));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("database is locked")) {
              lockedErrors.push(msg);
            } else {
              otherErrors.push(msg);
            }
          }
        }),
      );

      await Promise.all(writes);

      db.close();

      // Re-open to verify durability (not just in-memory state)
      const verify = initDatabase(dbPath);
      const stored = verify
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM entries WHERE id LIKE ?",
        )
        .get(`run-${run}-entry-%`);
      verify.close();

      // Zero "database is locked" errors after WAL + busy_timeout + withRetry
      expect(lockedErrors).toHaveLength(0);

      // No other unexpected errors either
      expect(otherErrors).toHaveLength(0);

      // All 50 entries durably written
      expect(stored?.n).toBe(WRITE_COUNT);
    });

    test("withRetry re-throws non-lock errors immediately", () => {
      expect(() =>
        withRetry(() => {
          throw new Error("some unrelated database error");
        }),
      ).toThrow("some unrelated database error");
    });

    test("withRetry succeeds when fn passes on second attempt", () => {
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
}
