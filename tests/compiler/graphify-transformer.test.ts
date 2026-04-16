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

test("transformGraphify imports nodes and links correctly", () => {
  const mockData = {
    nodes: [
      { id: "node1", label: "func1()", file_type: "code", source_file: "src/file1.ts", norm_label: "func1" },
      { id: "node2", label: "class2", file_type: "code", source_file: "src/file2.ts" }
    ],
    links: [
      { source: "node1", target: "node2", relation: "calls", weight: 0.8 }
    ]
  };

  writeFileSync(join(TEST_DIR, "graph.json"), JSON.stringify(mockData));

  const report = transformGraphify(db, TEST_DIR);

  expect(report.nodesImported).toBe(2);
  expect(report.linksImported).toBe(1);

  // Verify entries
  const entries = db.query("SELECT id, type, title FROM entries WHERE type = 'structural'").all() as any[];
  expect(entries.length).toBe(2);
  expect(entries.find(e => e.id === "node1").title).toBe("func1()");

  // Verify relationships
  const rels = db.query("SELECT source_id, target_id, type, strength FROM relationships").all() as any[];
  expect(rels.length).toBe(1);
  expect(rels[0].type).toBe("calls");
  expect(rels[0].strength).toBe(0.8);

  // Verify tags
  const tags = db.query("SELECT tag FROM entry_tags WHERE entry_id = 'node1'").all() as any[];
  expect(tags.length).toBe(1);
  expect(tags[0].tag).toBe("func1");
});

test("transformGraphify handles missing graph.json gracefully", () => {
  const report = transformGraphify(db, "non-existent-dir");
  expect(report.nodesImported).toBe(0);
});
