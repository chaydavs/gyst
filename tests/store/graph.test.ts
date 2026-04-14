/**
 * Tests for the graph query engine in src/store/graph.ts.
 *
 * Uses an in-memory SQLite database seeded with 8 entries and a set of
 * known relationships to exercise every exported function.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { createRelationship } from "../../src/compiler/linker.js";
import {
  getNeighbors,
  getFileSubgraph,
  getClusters,
  findPath,
  getHubs,
  recordCoRetrieval,
  strengthenCoRetrievedLinks,
} from "../../src/store/graph.js";

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory database with 8 test entries, 5 relationships, and
 * 2 entry_files rows.
 */
function setupGraphDb(): Database {
  const db = initDatabase(":memory:");
  const now = new Date().toISOString();

  // Insert 8 entries with known IDs
  const entries = [
    { id: "e1", type: "learning",      title: "Entry 1", confidence: 0.9, status: "active" },
    { id: "e2", type: "convention",    title: "Entry 2", confidence: 0.8, status: "active" },
    { id: "e3", type: "decision",      title: "Entry 3", confidence: 0.7, status: "active" },
    { id: "e4", type: "error_pattern", title: "Entry 4", confidence: 0.6, status: "active" },
    { id: "e5", type: "learning",      title: "Entry 5", confidence: 0.5, status: "active" },
    { id: "e6", type: "learning",      title: "Entry 6", confidence: 0.4, status: "active" },
    { id: "e7", type: "learning",      title: "Entry 7", confidence: 0.3, status: "active" },
    { id: "e8", type: "learning",      title: "Entry 8", confidence: 0.2, status: "archived" },
  ] as const;

  for (const e of entries) {
    db.run(
      `INSERT INTO entries
         (id, type, title, content, confidence, scope, status, created_at, last_confirmed)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [e.id, e.type, e.title, "test", e.confidence, "team", e.status, now, now],
    );
  }

  // Create relationships
  createRelationship(db, "e1", "e2", "related_to");
  createRelationship(db, "e2", "e3", "related_to");
  createRelationship(db, "e3", "e4", "related_to");
  createRelationship(db, "e5", "e6", "related_to"); // disconnected component
  createRelationship(db, "e1", "e8", "related_to"); // e8 is archived

  // Insert entry_files
  db.run("INSERT INTO entry_files(entry_id, file_path) VALUES (?,?)", ["e1", "src/api/auth.ts"]);
  db.run("INSERT INTO entry_files(entry_id, file_path) VALUES (?,?)", ["e2", "src/api/auth.ts"]);

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: Database;

beforeAll(() => {
  db = setupGraphDb();
});

// ---------------------------------------------------------------------------
describe("getNeighbors", () => {
  test("returns neighbors in both directions", () => {
    // e2 is connected to e1 (inbound) and e3 (outbound)
    const result = getNeighbors(db, "e2");
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain("e1");
    expect(nodeIds).toContain("e3");
  });

  test("respects limit", () => {
    // e2 has 2 neighbors; requesting limit=1 should return exactly 1 node
    const result = getNeighbors(db, "e2", 1);
    expect(result.nodes.length).toBe(1);
  });

  test("excludes archived entries", () => {
    // e8 is archived; it must not appear in e1's neighbor nodes
    const result = getNeighbors(db, "e1");
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain("e8");
  });
});

// ---------------------------------------------------------------------------
describe("getFileSubgraph", () => {
  test("finds entries by file path", () => {
    const result = getFileSubgraph(db, ["src/api/auth.ts"]);
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain("e1");
    expect(nodeIds).toContain("e2");
  });

  test("returns empty subgraph for empty paths", () => {
    const result = getFileSubgraph(db, []);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  test("includes edges between seed entries", () => {
    const result = getFileSubgraph(db, ["src/api/auth.ts"]);
    // The e1->e2 relationship should appear in the edges
    const hasEdge = result.edges.some(
      (e) => (e.source === "e1" && e.target === "e2") ||
              (e.source === "e2" && e.target === "e1"),
    );
    expect(hasEdge).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("getClusters", () => {
  test("finds two disconnected components", () => {
    const clusters = getClusters(db);
    // e1-e2-e3-e4 form one cluster; e5-e6 form another
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });

  test("filters by minSize", () => {
    const clusters = getClusters(db, 3);
    // e5-e6 has only 2 nodes and should be excluded
    for (const cluster of clusters) {
      expect(cluster.nodes.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
describe("findPath", () => {
  test("finds path between connected entries", () => {
    const path = findPath(db, "e1", "e4");
    // Should be ["e1", "e2", "e3", "e4"]
    expect(path).toHaveLength(4);
    expect(path[0]).toBe("e1");
    expect(path[1]).toBe("e2");
    expect(path[2]).toBe("e3");
    expect(path[3]).toBe("e4");
  });

  test("returns empty array when no path", () => {
    // e5 and e6 are in a disconnected component from e1
    const path = findPath(db, "e1", "e5");
    expect(path).toHaveLength(0);
  });

  test("handles self gracefully without throwing", () => {
    // findPath(e1 -> e1) must not throw; returns [e1] per implementation
    expect(() => findPath(db, "e1", "e1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("recordCoRetrieval + strengthenCoRetrievedLinks", () => {
  test("canonicalizes pair order", () => {
    const localDb = setupGraphDb();
    // Pass in reverse order — should store entry_a < entry_b
    recordCoRetrieval(localDb, ["e3", "e1"]);

    interface CoRow { entry_a: string; entry_b: string }
    const row = localDb
      .query<CoRow, []>("SELECT entry_a, entry_b FROM co_retrievals LIMIT 1")
      .get();

    expect(row).not.toBeNull();
    expect(row!.entry_a).toBe("e1");
    expect(row!.entry_b).toBe("e3");
  });

  test("increments count on repeat", () => {
    const localDb = setupGraphDb();

    recordCoRetrieval(localDb, ["e1", "e2"]);
    recordCoRetrieval(localDb, ["e1", "e2"]);
    recordCoRetrieval(localDb, ["e1", "e2"]);

    interface CoRow { count: number }
    const row = localDb
      .query<CoRow, [string, string]>(
        "SELECT count FROM co_retrievals WHERE entry_a=? AND entry_b=?",
      )
      .get("e1", "e2");

    expect(row).not.toBeNull();
    expect(row!.count).toBe(3);
  });

  test("strengthenCoRetrievedLinks creates edges at threshold", () => {
    const localDb = setupGraphDb();

    // Insert two fresh entries for this test so they have no pre-existing edge
    const now = new Date().toISOString();
    localDb.run(
      `INSERT INTO entries
         (id, type, title, content, confidence, scope, status, created_at, last_confirmed)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["eA", "learning", "Entry A", "test", 0.8, "team", "active", now, now],
    );
    localDb.run(
      `INSERT INTO entries
         (id, type, title, content, confidence, scope, status, created_at, last_confirmed)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["eB", "learning", "Entry B", "test", 0.8, "team", "active", now, now],
    );

    // Record 3 co-retrievals to hit the default threshold
    recordCoRetrieval(localDb, ["eA", "eB"]);
    recordCoRetrieval(localDb, ["eA", "eB"]);
    recordCoRetrieval(localDb, ["eA", "eB"]);

    const promoted = strengthenCoRetrievedLinks(localDb, 3);
    expect(promoted).toBeGreaterThanOrEqual(1);

    // Verify a relationship now exists
    interface RelRow { source_id: string }
    const rel = localDb
      .query<RelRow, [string, string, string, string]>(
        `SELECT source_id FROM relationships
         WHERE (source_id=? AND target_id=?) OR (source_id=? AND target_id=?)`,
      )
      .get("eA", "eB", "eB", "eA");

    expect(rel).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("getHubs", () => {
  test("ranks by degree", () => {
    // e2 is connected to e1 AND e3 (degree=2); e5 only to e6 (degree=1)
    const hubs = getHubs(db, 5);
    const ids = hubs.map((h) => h.id);

    const e2Pos = ids.indexOf("e2");
    const e5Pos = ids.indexOf("e5");

    // Both must appear in the top-5 result set
    expect(e2Pos).toBeGreaterThanOrEqual(0);
    expect(e5Pos).toBeGreaterThanOrEqual(0);

    // e2 should rank higher (smaller index = higher rank)
    expect(e2Pos).toBeLessThan(e5Pos);
  });
});
