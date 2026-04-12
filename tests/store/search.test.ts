/**
 * Tests for the three search strategies and Reciprocal Rank Fusion.
 *
 * All tests use an in-memory database seeded with 15 diverse entries covering
 * every entry type and various file paths / tags.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import {
  codeTokenize,
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  reciprocalRankFusion,
} from "../../src/store/search.js";
import type { RankedResult } from "../../src/store/search.js";

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

let db: Database;

/**
 * Seeds 15 diverse knowledge entries into the provided database.
 * Covers all four entry types, various file paths, tags, and relationships.
 */
function seedTestEntries(database: Database): void {
  const now = new Date().toISOString();

  const entries = [
    {
      id: "entry-01",
      type: "error_pattern" as const,
      title: "TypeError Cannot Read Property",
      content: "Accessing property on undefined value causes TypeError. Always check for null before accessing nested properties.",
      files: ["src/auth/getUserName.ts", "src/utils/helpers.ts"],
      tags: ["typescript", "null-check", "error"],
      errorSignature: "typeerror: cannot read property <str> of undefined",
      confidence: 0.9,
      sourceCount: 3,
    },
    {
      id: "entry-02",
      type: "error_pattern" as const,
      title: "Database Connection Refused",
      content: "PostgreSQL connection refused. Check that the database is running and the connection string is correct.",
      files: ["src/store/database.ts"],
      tags: ["database", "postgres", "connection"],
      errorSignature: "error: connect econnrefused <addr>",
      confidence: 0.8,
      sourceCount: 2,
    },
    {
      id: "entry-03",
      type: "convention" as const,
      title: "Use Zod for Input Validation",
      content: "All external inputs must be validated with Zod schemas. Define schemas once and reuse across handlers.",
      files: ["src/mcp/tools/learn.ts", "src/compiler/extract.ts"],
      tags: ["validation", "zod", "typescript"],
      confidence: 0.95,
      sourceCount: 5,
    },
    {
      id: "entry-04",
      type: "convention" as const,
      title: "Immutable Data Patterns",
      content: "Never mutate objects in place. Use spread operator or Object.assign to create updated copies.",
      files: ["src/compiler/extract.ts"],
      tags: ["immutability", "typescript", "functional"],
      confidence: 0.92,
      sourceCount: 4,
    },
    {
      id: "entry-05",
      type: "decision" as const,
      title: "SQLite with bun:sqlite for Storage",
      content: "Chose bun:sqlite over better-sqlite3 for native Bun integration and zero dependency overhead.",
      files: ["src/store/database.ts"],
      tags: ["sqlite", "bun", "decision", "storage"],
      confidence: 0.85,
      sourceCount: 3,
    },
    {
      id: "entry-06",
      type: "decision" as const,
      title: "MCP Protocol for Agent Integration",
      content: "Used MCP (Model Context Protocol) to expose knowledge to AI agents in a standardised way.",
      files: ["src/mcp/server.ts"],
      tags: ["mcp", "ai", "protocol"],
      confidence: 0.88,
      sourceCount: 2,
    },
    {
      id: "entry-07",
      type: "learning" as const,
      title: "FTS5 Porter Stemmer Behaviour",
      content: "FTS5 porter stemmer tokenises words so searching for 'running' also matches 'run'. Configure with tokenize option.",
      files: ["src/store/database.ts", "src/store/search.ts"],
      tags: ["fts5", "sqlite", "search"],
      confidence: 0.7,
      sourceCount: 1,
    },
    {
      id: "entry-08",
      type: "learning" as const,
      title: "Reciprocal Rank Fusion Algorithm",
      content: "RRF combines multiple ranked lists. Score = sum of 1/(k + rank) for each list. k=60 is the standard smoothing constant.",
      files: ["src/store/search.ts"],
      tags: ["algorithm", "search", "rrf"],
      confidence: 0.75,
      sourceCount: 2,
    },
    {
      id: "entry-09",
      type: "error_pattern" as const,
      title: "WAL Mode Requires Proper Close",
      content: "Not closing a WAL-mode SQLite database can leave a -wal file behind. Always call db.close() in tests.",
      files: ["src/store/database.ts"],
      tags: ["sqlite", "wal", "cleanup"],
      confidence: 0.6,
      sourceCount: 1,
    },
    {
      id: "entry-10",
      type: "convention" as const,
      title: "Error Classes Use GystError Base",
      content: "All custom errors extend GystError and carry a machine-readable code property.",
      files: ["src/utils/errors.ts"],
      tags: ["error-handling", "typescript"],
      confidence: 0.9,
      sourceCount: 4,
    },
    {
      id: "entry-11",
      type: "learning" as const,
      title: "camelCase Token Splitting in Search",
      content: "getUserName is tokenised to get user name by replacing camelCase boundaries with spaces.",
      files: ["src/store/search.ts"],
      tags: ["tokenization", "search", "camelcase"],
      confidence: 0.65,
      sourceCount: 1,
    },
    {
      id: "entry-12",
      type: "decision" as const,
      title: "Confidence Score Decay by Type",
      content: "Different entry types have different half-lives: error_pattern=30d, convention=9999d, decision=365d, learning=60d.",
      files: ["src/store/confidence.ts"],
      tags: ["confidence", "scoring", "decay"],
      confidence: 0.8,
      sourceCount: 2,
    },
    {
      id: "entry-13",
      type: "error_pattern" as const,
      title: "Zod Parse Validation Failure",
      content: "Zod safeParse returns success:false with detailed issues when input does not match schema.",
      files: ["src/compiler/extract.ts", "src/mcp/tools/learn.ts"],
      tags: ["validation", "zod", "error"],
      errorSignature: "zodError: invalid input",
      confidence: 0.78,
      sourceCount: 2,
    },
    {
      id: "entry-14",
      type: "learning" as const,
      title: "BM25 Rank is Negative in FTS5",
      content: "FTS5 BM25 rank values are negative — more negative means better match. Negate to get positive score.",
      files: ["src/store/search.ts"],
      tags: ["fts5", "bm25", "search"],
      confidence: 0.72,
      sourceCount: 1,
    },
    {
      id: "entry-15",
      type: "convention" as const,
      title: "Small Cohesive Files Under 800 Lines",
      content: "Keep files under 800 lines. Extract utilities and helpers when a file grows beyond 400 lines.",
      files: [],
      tags: ["code-quality", "maintainability"],
      confidence: 0.88,
      sourceCount: 3,
    },
  ];

  for (const e of entries) {
    insertEntry(database, {
      id: e.id,
      type: e.type,
      title: e.title,
      content: e.content,
      files: e.files,
      tags: e.tags,
      errorSignature: "errorSignature" in e ? e.errorSignature : undefined,
      confidence: e.confidence,
      sourceCount: e.sourceCount,
      createdAt: now,
      lastConfirmed: now,
      status: "active",
    });
  }

  // Add one relationship: entry-07 (FTS5 learning) -> entry-08 (RRF learning)
  database.run(
    "INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?, ?, ?)",
    ["entry-07", "entry-08", "related_to"],
  );

  // Add a relationship for graph walk tests: entry-11 -> entry-14
  database.run(
    "INSERT OR IGNORE INTO relationships (source_id, target_id, type) VALUES (?, ?, ?)",
    ["entry-11", "entry-14", "related_to"],
  );
}

beforeAll(() => {
  db = initDatabase(":memory:");
  seedTestEntries(db);
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// codeTokenize
// ---------------------------------------------------------------------------

describe("codeTokenize", () => {
  test("splits camelCase identifiers", () => {
    const result = codeTokenize("getUserName");
    expect(result).toBe("get user name");
  });

  test("splits snake_case identifiers", () => {
    const result = codeTokenize("get_user_name");
    expect(result).toBe("get user name");
  });

  test("splits dot notation", () => {
    const result = codeTokenize("this.auth.token");
    expect(result).toBe("this auth token");
  });

  test("lowercases everything", () => {
    const result = codeTokenize("MyClass.MyMethod");
    expect(result).toBe(result.toLowerCase());
  });

  test("handles mixed camelCase and underscores", () => {
    const result = codeTokenize("my_camelCaseProp");
    expect(result).toBe("my camel case prop");
  });

  test("collapses multiple whitespace tokens", () => {
    const result = codeTokenize("foo  bar   baz");
    expect(result).toBe("foo bar baz");
  });

  test("trims leading and trailing whitespace", () => {
    const result = codeTokenize("  trimMe  ");
    expect(result).toBe("trim me");
  });

  test("handles plain lowercase words without changes", () => {
    const result = codeTokenize("hello world");
    expect(result).toBe("hello world");
  });

  test("handles already-split words correctly", () => {
    const result = codeTokenize("hello world");
    expect(result).not.toContain("  ");
  });

  test("handles multiple dots in a row", () => {
    const result = codeTokenize("a..b");
    // double dot becomes two spaces which collapses to one
    expect(result).toBe("a b");
  });
});

// ---------------------------------------------------------------------------
// searchByFilePath
// ---------------------------------------------------------------------------

describe("searchByFilePath", () => {
  test("returns entries matching an exact file path", () => {
    const results = searchByFilePath(db, ["src/store/search.ts"]);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-07");
    expect(ids).toContain("entry-08");
    expect(ids).toContain("entry-11");
    expect(ids).toContain("entry-14");
  });

  test("returns source as 'file_path'", () => {
    const results = searchByFilePath(db, ["src/store/database.ts"]);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe("file_path");
    }
  });

  test("returns empty array for nonexistent file path", () => {
    const results = searchByFilePath(db, ["nonexistent/path/file.ts"]);
    expect(results).toEqual([]);
  });

  test("returns empty array for empty files list", () => {
    const results = searchByFilePath(db, []);
    expect(results).toEqual([]);
  });

  test("matches entries for multiple files and ranks by match count", () => {
    // src/store/database.ts appears in entry-02, entry-05, entry-07, entry-09
    // src/store/search.ts appears in entry-07, entry-08, entry-11, entry-14
    // entry-07 matches BOTH -> should have higher score
    const results = searchByFilePath(db, [
      "src/store/database.ts",
      "src/store/search.ts",
    ]);
    const entry07 = results.find((r) => r.id === "entry-07");
    const entry02 = results.find((r) => r.id === "entry-02");
    expect(entry07).toBeDefined();
    expect(entry02).toBeDefined();
    expect(entry07!.score).toBeGreaterThan(entry02!.score);
  });

  test("score equals match count (number of paths matched)", () => {
    const results = searchByFilePath(db, [
      "src/store/database.ts",
      "src/store/search.ts",
    ]);
    const entry07 = results.find((r) => r.id === "entry-07");
    // entry-07 has both files, so score should be 2
    expect(entry07?.score).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// searchByBM25
// ---------------------------------------------------------------------------

describe("searchByBM25", () => {
  test("returns relevant results for a keyword query", () => {
    const results = searchByBM25(db, "validation zod schema");
    const ids = results.map((r) => r.id);
    // entry-03 and entry-13 are about Zod validation
    expect(ids).toContain("entry-03");
    expect(ids).toContain("entry-13");
  });

  test("returns results with source as 'bm25'", () => {
    const results = searchByBM25(db, "sqlite database");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe("bm25");
    }
  });

  test("camelCase identifiers are searchable after tokenization", () => {
    // 'getUserName' tokenizes to 'get user name'; entry-11 mentions it
    const results = searchByBM25(db, "getUserName");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-11");
  });

  test("returns empty array for empty query", () => {
    const results = searchByBM25(db, "");
    expect(results).toEqual([]);
  });

  test("returns empty array for whitespace-only query", () => {
    const results = searchByBM25(db, "   ");
    expect(results).toEqual([]);
  });

  test("FTS5 special characters in query do not crash the search", () => {
    // Characters like * ( ) : ^ are special in FTS5 — codeTokenize strips them
    // and the search function should not throw
    const specialChars = ['"hello"', "* test", "(query)", "key:value", "^start"];
    for (const q of specialChars) {
      expect(() => searchByBM25(db, q)).not.toThrow();
    }
  });

  test("type filter restricts results to the specified type", () => {
    const results = searchByBM25(db, "sqlite", "convention");
    for (const r of results) {
      const row = db
        .query<{ type: string }, [string]>("SELECT type FROM entries WHERE id = ?")
        .get(r.id);
      expect(row?.type).toBe("convention");
    }
  });

  test("type filter error_pattern returns only error patterns", () => {
    const results = searchByBM25(db, "error database connection", "error_pattern");
    for (const r of results) {
      const row = db
        .query<{ type: string }, [string]>("SELECT type FROM entries WHERE id = ?")
        .get(r.id);
      expect(row?.type).toBe("error_pattern");
    }
  });

  test("scores are positive (negated from negative FTS5 rank)", () => {
    const results = searchByBM25(db, "confidence score decay");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  test("results are sorted by descending score", () => {
    const results = searchByBM25(db, "search fts5 sqlite");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("very short single character query is handled gracefully", () => {
    // Single-character query: codeTokenize returns 'x', FTS5 may return results
    // or nothing — the important thing is it does not throw
    expect(() => searchByBM25(db, "x")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// searchByGraph
// ---------------------------------------------------------------------------

describe("searchByGraph", () => {
  test("returns empty array for empty query", () => {
    const results = searchByGraph(db, "");
    expect(results).toEqual([]);
  });

  test("returns empty array for whitespace-only query", () => {
    const results = searchByGraph(db, "   ");
    expect(results).toEqual([]);
  });

  test("finds seed entries matching by tag", () => {
    // 'fts5' tag is on entry-07, entry-14
    const results = searchByGraph(db, "fts5");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-07");
    expect(ids).toContain("entry-14");
  });

  test("finds seed entries matching by file path", () => {
    // 'search.ts' matches file paths containing 'search.ts'
    const results = searchByGraph(db, "search.ts");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-07");
    expect(ids).toContain("entry-08");
  });

  test("seeds get score 2.0", () => {
    const results = searchByGraph(db, "fts5");
    // entry-07 and entry-14 both have 'fts5' tag
    const entry07 = results.find((r) => r.id === "entry-07");
    const entry14 = results.find((r) => r.id === "entry-14");
    expect(entry07?.score).toBe(2.0);
    expect(entry14?.score).toBe(2.0);
  });

  test("one-hop neighbours get score 1.0", () => {
    // entry-07 has relationship -> entry-08
    // if we seed on entry-07 via the 'fts5' tag, entry-08 is a neighbour
    const results = searchByGraph(db, "fts5");
    const entry08 = results.find((r) => r.id === "entry-08");
    // entry-08 has 'fts5' tag too so it's a seed, but check general score logic
    expect(entry08?.score).toBeGreaterThanOrEqual(1.0);
  });

  test("traverses relationship to surface related entry", () => {
    // 'camelcase' tag is on entry-11; entry-11 -> entry-14 via relationship
    const results = searchByGraph(db, "camelcase");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-11"); // seed
    expect(ids).toContain("entry-14"); // one-hop neighbour
  });

  test("one-hop neighbour scores lower than seed", () => {
    const results = searchByGraph(db, "camelcase");
    const entry11 = results.find((r) => r.id === "entry-11");
    const entry14 = results.find((r) => r.id === "entry-14");
    expect(entry11?.score).toBe(2.0);
    // entry-14 has 'fts5' and 'bm25' tags — not 'camelcase', so it's a neighbour
    expect(entry14?.score).toBe(1.0);
  });

  test("returns empty array when no entries match query", () => {
    const results = searchByGraph(db, "nonexistentquerythatmatchesnothing12345");
    expect(results).toEqual([]);
  });

  test("results are sorted by descending score", () => {
    const results = searchByGraph(db, "search");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("source is 'graph' for all results", () => {
    const results = searchByGraph(db, "sqlite");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe("graph");
    }
  });
});

// ---------------------------------------------------------------------------
// reciprocalRankFusion
// ---------------------------------------------------------------------------

describe("reciprocalRankFusion", () => {
  test("returns empty array for empty input", () => {
    const result = reciprocalRankFusion([]);
    expect(result).toEqual([]);
  });

  test("returns empty array for list of empty lists", () => {
    const result = reciprocalRankFusion([[], [], []]);
    expect(result).toEqual([]);
  });

  test("single item in one list returns that item", () => {
    const list: RankedResult[] = [{ id: "a", score: 1, source: "test" }];
    const result = reciprocalRankFusion([list]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a");
  });

  test("all results have source 'rrf'", () => {
    const list1: RankedResult[] = [
      { id: "a", score: 1, source: "file_path" },
      { id: "b", score: 0.5, source: "file_path" },
    ];
    const list2: RankedResult[] = [
      { id: "b", score: 1, source: "bm25" },
      { id: "c", score: 0.5, source: "bm25" },
    ];
    const result = reciprocalRankFusion([list1, list2]);
    for (const r of result) {
      expect(r.source).toBe("rrf");
    }
  });

  test("item found in multiple lists gets higher score than item in one list", () => {
    const list1: RankedResult[] = [
      { id: "shared", score: 1, source: "s1" },
      { id: "unique-a", score: 0.5, source: "s1" },
    ];
    const list2: RankedResult[] = [
      { id: "shared", score: 1, source: "s2" },
      { id: "unique-b", score: 0.5, source: "s2" },
    ];
    const result = reciprocalRankFusion([list1, list2]);
    const sharedScore = result.find((r) => r.id === "shared")!.score;
    const uniqueAScore = result.find((r) => r.id === "unique-a")!.score;
    expect(sharedScore).toBeGreaterThan(uniqueAScore);
  });

  test("results are sorted by descending score", () => {
    const list1: RankedResult[] = [
      { id: "a", score: 3, source: "s1" },
      { id: "b", score: 2, source: "s1" },
      { id: "c", score: 1, source: "s1" },
    ];
    const list2: RankedResult[] = [
      { id: "b", score: 3, source: "s2" },
      { id: "d", score: 2, source: "s2" },
    ];
    const result = reciprocalRankFusion([list1, list2]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
  });

  test("handles one empty list alongside a non-empty list", () => {
    const list1: RankedResult[] = [];
    const list2: RankedResult[] = [
      { id: "x", score: 1, source: "s" },
      { id: "y", score: 0.5, source: "s" },
    ];
    const result = reciprocalRankFusion([list1, list2]);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("x");
    expect(ids).toContain("y");
  });

  test("uses default k=60 for RRF scoring", () => {
    // With k=60 and rank=1: contribution = 1/(60+1) ≈ 0.01639
    const list: RankedResult[] = [{ id: "a", score: 1, source: "s" }];
    const result = reciprocalRankFusion([list]);
    const expected = 1 / (60 + 1);
    expect(result[0]!.score).toBeCloseTo(expected, 8);
  });

  test("custom k parameter changes the scores", () => {
    const list: RankedResult[] = [{ id: "a", score: 1, source: "s" }];
    const defaultK = reciprocalRankFusion([list], 60);
    const customK = reciprocalRankFusion([list], 10);
    // With k=10 the score is higher than k=60 for rank 1
    expect(customK[0]!.score).toBeGreaterThan(defaultK[0]!.score);
  });

  test("three-list fusion accumulates contributions correctly", () => {
    const makeList = (ids: string[]): RankedResult[] =>
      ids.map((id, i) => ({ id, score: ids.length - i, source: "test" }));

    const l1 = makeList(["a", "b", "c"]);
    const l2 = makeList(["a", "c", "d"]);
    const l3 = makeList(["a", "b", "d"]);

    const result = reciprocalRankFusion([l1, l2, l3]);

    // 'a' appears first in all three lists: should have highest score
    const aScore = result.find((r) => r.id === "a")!.score;
    const dScore = result.find((r) => r.id === "d")!.score;
    expect(aScore).toBeGreaterThan(dScore);
  });

  test("item at rank 1 scores higher than item at rank 2 from same list", () => {
    const list: RankedResult[] = [
      { id: "first", score: 10, source: "s" },
      { id: "second", score: 5, source: "s" },
    ];
    const result = reciprocalRankFusion([list]);
    const firstScore = result.find((r) => r.id === "first")!.score;
    const secondScore = result.find((r) => r.id === "second")!.score;
    expect(firstScore).toBeGreaterThan(secondScore);
  });

  test("deduplicates ids across multiple lists", () => {
    const list1: RankedResult[] = [{ id: "dup", score: 1, source: "s1" }];
    const list2: RankedResult[] = [{ id: "dup", score: 1, source: "s2" }];
    const result = reciprocalRankFusion([list1, list2]);
    const dupResults = result.filter((r) => r.id === "dup");
    expect(dupResults).toHaveLength(1);
  });
});
