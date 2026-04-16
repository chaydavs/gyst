import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initDatabase } from "../../src/store/database.js";
import { transformGraphify } from "../../src/compiler/graphify-transformer.js";

let db: Database;
const TEST_DIR = "test-graphify-out";

beforeEach(() => {
  db = initDatabase(":memory:");
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("transformGraphify writes nodes + edges to the adjacent structural index", () => {
  const mockData = {
    nodes: [
      { id: "node1", label: "func1()", file_type: "code", source_file: "src/file1.ts", norm_label: "func1" },
      { id: "node2", label: "class2", file_type: "code", source_file: "src/file2.ts", source_location: "12:5" },
    ],
    links: [
      { source: "node1", target: "node2", relation: "calls", weight: 0.8 },
    ],
  };

  writeFileSync(join(TEST_DIR, "graph.json"), JSON.stringify(mockData));

  const report = transformGraphify(db, TEST_DIR);

  expect(report.nodesImported).toBe(2);
  expect(report.linksImported).toBe(1);

  const nodes = db
    .query("SELECT id, label, file_path, norm_label, source_location FROM structural_nodes ORDER BY id")
    .all() as any[];
  expect(nodes.length).toBe(2);
  expect(nodes[0].id).toBe("node1");
  expect(nodes[0].label).toBe("func1()");
  expect(nodes[0].file_path).toBe("src/file1.ts");
  expect(nodes[0].norm_label).toBe("func1");
  expect(nodes[1].source_location).toBe("12:5");

  const edges = db
    .query("SELECT source_id, target_id, relation, weight FROM structural_edges")
    .all() as any[];
  expect(edges.length).toBe(1);
  expect(edges[0].relation).toBe("calls");
  expect(edges[0].weight).toBe(0.8);

  // The curated entries + relationships tables must stay untouched —
  // structural data is adjacent, not mixed.
  const entryCount = (db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  const relCount = (db.query("SELECT COUNT(*) AS n FROM relationships").get() as { n: number }).n;
  expect(entryCount).toBe(0);
  expect(relCount).toBe(0);
});

test("transformGraphify is idempotent — re-running updates last_seen without duplicating", () => {
  const mockData = {
    nodes: [{ id: "n1", label: "a", file_type: "code", source_file: "a.ts" }],
    links: [] as any[],
  };
  writeFileSync(join(TEST_DIR, "graph.json"), JSON.stringify(mockData));

  transformGraphify(db, TEST_DIR);
  const firstSeen = (db
    .query("SELECT last_seen FROM structural_nodes WHERE id='n1'")
    .get() as { last_seen: string }).last_seen;

  // Second run should UPSERT — count stays at 1.
  transformGraphify(db, TEST_DIR);
  const count = (db.query("SELECT COUNT(*) AS n FROM structural_nodes").get() as { n: number }).n;
  expect(count).toBe(1);

  const secondSeen = (db
    .query("SELECT last_seen FROM structural_nodes WHERE id='n1'")
    .get() as { last_seen: string }).last_seen;
  // last_seen should be >= first run (ISO strings compare correctly).
  expect(secondSeen >= firstSeen).toBe(true);
});

test("transformGraphify handles missing graph.json gracefully", () => {
  const report = transformGraphify(db, "non-existent-dir");
  expect(report.nodesImported).toBe(0);
  expect(report.linksImported).toBe(0);
});
