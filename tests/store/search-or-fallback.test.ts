/**
 * H2 — BM25 OR-mode fallback.
 *
 * Gyst's FTS5 BM25 uses implicit-AND: every query term must co-occur in one
 * entry. On natural-language questions ("vintage cameras hobby") this returns
 * zero rows even when an entry is clearly relevant ("collecting old film
 * cameras"). The fix: when the AND match yields ZERO rows, retry once in
 * OR-mode (any term may match). When the AND match already returns rows, the
 * fallback must NOT trigger (no behavior change for the common case), and a
 * query whose terms are genuinely absent must still return empty (no false
 * positives).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import { searchByBM25 } from "../../src/store/search.js";

let db: Database;

beforeAll(() => {
  db = initDatabase(":memory:");
  insertEntry(db, {
    id: "cameras",
    type: "learning",
    title: "Camera collecting",
    content: "user: I have been collecting old film cameras since March. assistant: nice hobby!",
    files: [],
    tags: [],
    confidence: 0.5,
    sourceCount: 1,
    scope: "team",
  });
  insertEntry(db, {
    id: "volleyball",
    type: "learning",
    title: "Volleyball league",
    content: "user: my recreational volleyball league record is 5-2 this season",
    files: [],
    tags: [],
    confidence: 0.5,
    sourceCount: 1,
    scope: "team",
  });
});

afterAll(() => {
  db.close();
});

describe("searchByBM25 OR-mode fallback (H2)", () => {
  test("AND-match still works unchanged when all terms co-occur", () => {
    const r = searchByBM25(db, "film cameras");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe("cameras");
  });

  test("falls back to OR when implicit-AND yields zero rows", () => {
    // "vintage" and "hobby" are absent from the entry text → implicit-AND = 0.
    // OR-fallback should still match on "cameras".
    const r = searchByBM25(db, "vintage cameras hobby");
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.id === "cameras")).toBe(true);
  });

  test("genuinely-absent query still returns empty (no false positives)", () => {
    const r = searchByBM25(db, "quantum spacecraft propulsion");
    expect(r.length).toBe(0);
  });
});
