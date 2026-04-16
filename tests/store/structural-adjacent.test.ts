import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import {
  getStructuralForFiles,
  getStructuralForEntries,
} from "../../src/store/structural.js";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  const now = new Date().toISOString();
  // Seed 3 structural nodes, 2 of them sharing a file_path.
  db.run(
    `INSERT INTO structural_nodes
       (id, label, file_path, file_type, source_location, norm_label,
        created_at, last_seen)
     VALUES
       ('s1','authLogin()','src/auth.ts','code','12:0','auth login',?,?),
       ('s2','validateSession()','src/auth.ts','code','40:2','validate session',?,?),
       ('s3','renderChart()','src/ui/chart.ts','code',NULL,'render chart',?,?)`,
    [now, now, now, now, now, now],
  );
});

describe("getStructuralForFiles", () => {
  test("returns nodes matching supplied paths, ordered by last_seen DESC", () => {
    const result = getStructuralForFiles(db, ["src/auth.ts"]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    const s1 = result.find((r) => r.id === "s1");
    expect(s1?.filePath).toBe("src/auth.ts");
    expect(s1?.sourceLocation).toBe("12:0");
  });

  test("empty path list returns empty array (no over-fetching)", () => {
    expect(getStructuralForFiles(db, [])).toEqual([]);
  });

  test("deduplicates overlapping file paths", () => {
    // Duplicate input shouldn't produce duplicate output rows.
    const result = getStructuralForFiles(db, ["src/auth.ts", "src/auth.ts"]);
    expect(result).toHaveLength(2);
  });

  test("respects the limit cap", () => {
    const result = getStructuralForFiles(db, ["src/auth.ts"], 1);
    expect(result).toHaveLength(1);
  });

  test("no match returns empty array", () => {
    expect(getStructuralForFiles(db, ["src/nowhere.ts"])).toEqual([]);
  });
});

describe("getStructuralForEntries", () => {
  test("resolves entry_ids via entry_files and returns matching structural nodes", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO entries (id, type, title, content, confidence, scope, status, created_at, last_confirmed)
       VALUES ('e1','learning','auth notes','',0.8,'team','active',?,?)`,
      [now, now],
    );
    db.run(
      "INSERT INTO entry_files(entry_id, file_path) VALUES ('e1','src/auth.ts')",
    );

    const result = getStructuralForEntries(db, ["e1"]);
    expect(result.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });

  test("merges explicit file context with entry-derived paths", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO entries (id, type, title, content, confidence, scope, status, created_at, last_confirmed)
       VALUES ('e1','learning','auth notes','',0.8,'team','active',?,?)`,
      [now, now],
    );
    db.run(
      "INSERT INTO entry_files(entry_id, file_path) VALUES ('e1','src/auth.ts')",
    );

    // entry gives src/auth.ts; explicit adds src/ui/chart.ts → both surface.
    const result = getStructuralForEntries(db, ["e1"], ["src/ui/chart.ts"], 10);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  test("empty entries + empty explicit files returns empty array", () => {
    expect(getStructuralForEntries(db, [], [])).toEqual([]);
  });
});
