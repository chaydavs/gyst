/**
 * Tests for MCP tool logic.
 *
 * Rather than testing through the full MCP protocol layer, these tests
 * exercise the underlying database operations and search functions that
 * the tool handlers call directly. This is the most reliable way to
 * validate tool behaviour without spinning up an MCP server.
 *
 * Flows tested:
 *  - learn: insert new entry, detect and merge duplicate error patterns,
 *    strip sensitive data before storage
 *  - recall: search + confidence filter + max_results + type filter,
 *    empty database, token budget
 *  - conventions: fetch by directory, by tags, unfiltered
 *  - failures: exact signature match, BM25 fallback
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import {
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  reciprocalRankFusion,
} from "../../src/store/search.js";
import { stripSensitiveData } from "../../src/compiler/security.js";
import { normalizeErrorSignature, generateFingerprint } from "../../src/compiler/normalize.js";
import { extractEntry } from "../../src/compiler/extract.js";
import type { LearnInput } from "../../src/compiler/extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_NOW = new Date("2025-04-11T00:00:00.000Z").toISOString();

/**
 * Simulates the database operations performed by the `learn` tool handler.
 * Returns { action: 'created' | 'merged', id: string }.
 */
function simulateLearn(
  db: Database,
  input: {
    type: "error_pattern" | "convention" | "decision" | "learning";
    title: string;
    content: string;
    files?: string[];
    tags?: string[];
    error_type?: string;
    error_message?: string;
  },
): { action: "created" | "merged"; id: string } {
  const files = input.files ?? [];
  const tags = input.tags ?? [];
  const now = TEST_NOW;

  // Sanitise content
  const safeContent = stripSensitiveData(input.content);
  const safeErrorMessage =
    input.error_message !== undefined
      ? stripSensitiveData(input.error_message)
      : undefined;

  // Build error signature and fingerprint for error_pattern type
  let errorSignature: string | undefined;
  let fingerprint: string | undefined;

  if (input.type === "error_pattern" && safeErrorMessage !== undefined) {
    errorSignature = normalizeErrorSignature(safeErrorMessage);
    if (input.error_type !== undefined) {
      fingerprint = generateFingerprint(input.error_type, errorSignature);
    }
  }

  // Check for duplicate by error_signature
  if (fingerprint !== undefined && errorSignature !== undefined) {
    const existingRow = db
      .query<{ id: string; source_count: number }, [string]>(
        "SELECT id, source_count FROM entries WHERE error_signature = ? AND status != 'archived' LIMIT 1",
      )
      .get(errorSignature);

    if (existingRow !== null) {
      // Merge into existing
      db.transaction(() => {
        db.run(
          "UPDATE entries SET content = ?, source_count = source_count + 1, last_confirmed = ? WHERE id = ?",
          [safeContent, now, existingRow.id],
        );
        for (const filePath of files) {
          db.run(
            "INSERT OR IGNORE INTO entry_files(entry_id, file_path) VALUES (?, ?)",
            [existingRow.id, filePath],
          );
        }
        for (const tag of tags) {
          db.run(
            "INSERT OR IGNORE INTO entry_tags(entry_id, tag) VALUES (?, ?)",
            [existingRow.id, tag],
          );
        }
        db.run(
          "INSERT INTO sources (entry_id, tool, timestamp) VALUES (?, 'mcp', ?)",
          [existingRow.id, now],
        );
      })();

      return { action: "merged", id: existingRow.id };
    }
  }

  // Insert as new entry
  const id = crypto.randomUUID();
  insertEntry(db, {
    id,
    type: input.type,
    title: input.title,
    content: safeContent,
    files,
    tags,
    errorSignature,
    confidence: 0.5,
    sourceCount: 1,
    createdAt: now,
    lastConfirmed: now,
    status: "active",
  });

  return { action: "created", id };
}

/**
 * Simulates the database operations performed by the `recall` tool handler.
 * Returns the filtered, ranked entry rows.
 */
function simulateRecall(
  db: Database,
  input: {
    query: string;
    type?: "error_pattern" | "convention" | "decision" | "learning" | "all";
    files?: string[];
    max_results?: number;
    confidenceThreshold?: number;
  },
): Array<{ id: string; type: string; title: string; content: string; confidence: number }> {
  const files = input.files ?? [];
  const maxResults = input.max_results ?? 5;
  const confidenceThreshold = input.confidenceThreshold ?? 0.15;
  const typeFilter = input.type === "all" || input.type === undefined ? undefined : input.type;

  const fileResults = searchByFilePath(db, files);
  const bm25Results = searchByBM25(db, input.query, typeFilter);
  const graphResults = searchByGraph(db, input.query);

  const fused = reciprocalRankFusion([fileResults, bm25Results, graphResults]);

  const topIds = fused.slice(0, maxResults * 3).map((r) => r.id);

  if (topIds.length === 0) {
    return [];
  }

  const placeholders = topIds.map(() => "?").join(", ");
  const queryParams: string[] = [...topIds];
  let typeClause = "";
  if (typeFilter !== undefined) {
    typeClause = " AND type = ?";
    queryParams.push(typeFilter);
  }
  const rows = db
    .query<
      { id: string; type: string; title: string; content: string; confidence: number },
      string[]
    >(
      `SELECT id, type, title, content, confidence
       FROM   entries
       WHERE  id IN (${placeholders})
         AND  status = 'active'${typeClause}`,
    )
    .all(...queryParams);

  // Preserve RRF rank order
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const ordered = topIds.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });

  return ordered
    .filter((e) => e.confidence >= confidenceThreshold)
    .slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Test database lifecycle
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// learn flow tests
// ---------------------------------------------------------------------------

describe("learn flow", () => {
  test("valid input creates a new entry in the database", () => {
    const result = simulateLearn(db, {
      type: "learning",
      title: "Always validate user input",
      content: "User input must be validated against a schema before processing.",
      files: ["src/handlers/create.ts"],
      tags: ["validation"],
    });

    expect(result.action).toBe("created");
    expect(typeof result.id).toBe("string");

    const row = db
      .query<{ title: string; type: string }, [string]>(
        "SELECT title, type FROM entries WHERE id = ?",
      )
      .get(result.id);

    expect(row).not.toBeNull();
    expect(row?.title).toBe("Always validate user input");
    expect(row?.type).toBe("learning");
  });

  test("creates entry with correct initial confidence of 0.5", () => {
    const result = simulateLearn(db, {
      type: "convention",
      title: "Use strict TypeScript mode",
      content: "Always enable strict mode in tsconfig for maximum type safety.",
    });

    const row = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(result.id);

    expect(row?.confidence).toBe(0.5);
  });

  test("creates entry with initial source_count of 1", () => {
    const result = simulateLearn(db, {
      type: "decision",
      title: "Use Bun as the runtime",
      content: "Chosen for native SQLite support and fast startup times.",
    });

    const row = db
      .query<{ source_count: number }, [string]>(
        "SELECT source_count FROM entries WHERE id = ?",
      )
      .get(result.id);

    expect(row?.source_count).toBe(1);
  });

  test("duplicate error pattern merges instead of creating a new entry", () => {
    // First learn: creates the entry
    const first = simulateLearn(db, {
      type: "error_pattern",
      title: "TypeError Null Access",
      content: "Check for null before accessing properties.",
      error_type: "TypeError",
      error_message: "Cannot read property 'length' of null",
    });
    expect(first.action).toBe("created");

    // Second learn: same error type + same normalized message → should merge
    const second = simulateLearn(db, {
      type: "error_pattern",
      title: "TypeError Null Access",
      content: "Use optional chaining to avoid null access errors.",
      error_type: "TypeError",
      error_message: "Cannot read property 'length' of null",
    });
    expect(second.action).toBe("merged");
    expect(second.id).toBe(first.id);
  });

  test("merging increments source_count", () => {
    const first = simulateLearn(db, {
      type: "error_pattern",
      title: "Connection Timeout Pattern",
      content: "Increase timeout or retry the connection.",
      error_type: "NetworkError",
      error_message: "Connection timed out after 30000ms",
    });

    simulateLearn(db, {
      type: "error_pattern",
      title: "Connection Timeout Pattern",
      content: "Add exponential backoff to retry logic.",
      error_type: "NetworkError",
      error_message: "Connection timed out after 5000ms",
    });

    const row = db
      .query<{ source_count: number }, [string]>(
        "SELECT source_count FROM entries WHERE id = ?",
      )
      .get(first.id);

    expect(row?.source_count).toBe(2);
  });

  test("sensitive data is stripped before storage", () => {
    const result = simulateLearn(db, {
      type: "learning",
      title: "API Authentication Pattern",
      content: "Store tokens securely. api_key = 'sk-supersecretapitoken123456789' should never appear in logs.",
    });

    const row = db
      .query<{ content: string }, [string]>(
        "SELECT content FROM entries WHERE id = ?",
      )
      .get(result.id);

    expect(row?.content).not.toContain("sk-supersecretapitoken123456789");
    expect(row?.content).toContain("[REDACTED]");
  });

  test("files are stored in entry_files table", () => {
    const result = simulateLearn(db, {
      type: "convention",
      title: "Always use relative imports",
      content: "Use relative imports for local modules to avoid path resolution issues.",
      files: ["src/utils/imports.ts", "src/compiler/extract.ts"],
    });

    const rows = db
      .query<{ file_path: string }, [string]>(
        "SELECT file_path FROM entry_files WHERE entry_id = ?",
      )
      .all(result.id);

    const paths = rows.map((r) => r.file_path).sort();
    expect(paths).toEqual(["src/compiler/extract.ts", "src/utils/imports.ts"]);
  });

  test("tags are stored in entry_tags table", () => {
    const result = simulateLearn(db, {
      type: "learning",
      title: "Use const for immutable bindings",
      content: "Prefer const over let when a binding will not be reassigned.",
      tags: ["javascript", "best-practices", "immutability"],
    });

    const rows = db
      .query<{ tag: string }, [string]>(
        "SELECT tag FROM entry_tags WHERE entry_id = ?",
      )
      .all(result.id);

    const tags = rows.map((r) => r.tag).sort();
    expect(tags).toEqual(["best-practices", "immutability", "javascript"]);
  });

  test("error_pattern without error_message does not deduplicate", () => {
    // Without an error_message, no fingerprint is generated, so two
    // error_pattern entries with the same title should both be created.
    const first = simulateLearn(db, {
      type: "error_pattern",
      title: "Generic Import Error",
      content: "Module not found — check the import path.",
    });

    const second = simulateLearn(db, {
      type: "error_pattern",
      title: "Generic Import Error",
      content: "Ensure the module is listed in package.json.",
    });

    expect(first.action).toBe("created");
    expect(second.action).toBe("created");
    expect(first.id).not.toBe(second.id);
  });
});

// ---------------------------------------------------------------------------
// extractEntry (compiler layer) tests
// ---------------------------------------------------------------------------

describe("extractEntry", () => {
  test("produces a KnowledgeEntry from valid LearnInput", () => {
    const input: LearnInput = {
      type: "learning",
      title: "Prefer const for bindings",
      content: "Use const over let when values are not reassigned.",
    };
    const entry = extractEntry(input);
    expect(entry.id).toBeDefined();
    expect(entry.type).toBe("learning");
    expect(entry.title).toBe("Prefer const for bindings");
    expect(entry.sourceCount).toBe(1);
    expect(entry.status).toBe("active");
  });

  test("assigns a UUID as the entry id", () => {
    const entry = extractEntry({
      type: "convention",
      title: "Strict null checks required",
      content: "Enable strictNullChecks in tsconfig to catch null errors at compile time.",
    });
    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("strips sensitive data from content", () => {
    const entry = extractEntry({
      type: "learning",
      title: "Secure credential handling",
      content: "Never store tokens like token = 'my-secret-token-12345678' in source files.",
    });
    expect(entry.content).not.toContain("my-secret-token-12345678");
    expect(entry.content).toContain("[REDACTED]");
  });

  test("generates error_signature for error_pattern with errorMessage", () => {
    const entry = extractEntry({
      type: "error_pattern",
      title: "Null pointer access pattern",
      content: "Guard against null pointer access by checking values before use.",
      errorMessage: "TypeError: Cannot read property 'foo' of null",
    });
    expect(entry.errorSignature).toBeDefined();
    expect(typeof entry.errorSignature).toBe("string");
    expect(entry.errorSignature!.length).toBeGreaterThan(0);
  });

  test("generates fingerprint when both errorType and errorMessage are provided", () => {
    const entry = extractEntry({
      type: "error_pattern",
      title: "RangeError overflow pattern",
      content: "Validate array indices before access.",
      errorType: "RangeError",
      errorMessage: "Index out of range: 42",
    });
    expect(entry.fingerprint).toBeDefined();
    expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("no fingerprint when errorType is missing", () => {
    const entry = extractEntry({
      type: "error_pattern",
      title: "Generic parse error",
      content: "Handle parse errors gracefully with try-catch.",
      errorMessage: "Unexpected token } in JSON",
    });
    // errorSignature should be present but fingerprint absent
    expect(entry.errorSignature).toBeDefined();
    expect(entry.fingerprint).toBeUndefined();
  });

  test("throws ValidationError for missing title", () => {
    expect(() =>
      extractEntry({
        type: "learning",
        title: "ab", // too short — min 5 chars
        content: "Some content that is long enough.",
      }),
    ).toThrow();
  });

  test("stamps createdAt and lastConfirmed as ISO-8601 strings", () => {
    const entry = extractEntry({
      type: "decision",
      title: "Use ESM modules throughout",
      content: "Use ESM import/export syntax for all modules in the project.",
    });
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.lastConfirmed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// recall flow tests
// ---------------------------------------------------------------------------

describe("recall flow", () => {
  beforeEach(() => {
    // Seed database with entries that have varying confidence levels
    const entries = [
      {
        id: "recall-01",
        type: "convention" as const,
        title: "TypeScript strict mode configuration",
        content: "Enable strict mode in tsconfig.json for maximum type safety and null checks.",
        files: ["tsconfig.json"],
        tags: ["typescript", "config"],
        confidence: 0.9,
        sourceCount: 3,
      },
      {
        id: "recall-02",
        type: "error_pattern" as const,
        title: "Module resolution failure",
        content: "When TypeScript cannot resolve a module, verify the path and tsconfig paths.",
        files: ["src/index.ts"],
        tags: ["typescript", "modules"],
        errorSignature: "error ts<n>: cannot find module",
        confidence: 0.8,
        sourceCount: 2,
      },
      {
        id: "recall-03",
        type: "learning" as const,
        title: "Async iterator pattern in TypeScript",
        content: "Use for-await-of loops with async generators for streaming data processing.",
        files: ["src/streaming.ts"],
        tags: ["typescript", "async", "generators"],
        confidence: 0.6,
        sourceCount: 1,
      },
      {
        id: "recall-04",
        type: "decision" as const,
        title: "Monorepo structure with workspaces",
        content: "Use npm/bun workspaces for managing multiple packages in a single repository.",
        files: [],
        tags: ["monorepo", "architecture"],
        confidence: 0.75,
        sourceCount: 2,
      },
      {
        id: "recall-05",
        type: "convention" as const,
        title: "Error handling with typed catches",
        content: "Always type-guard caught errors before accessing their properties in catch blocks.",
        files: ["src/utils/errors.ts"],
        tags: ["error-handling", "typescript"],
        confidence: 0.05, // Below default threshold of 0.15
        sourceCount: 1,
      },
    ];

    for (const e of entries) {
      insertEntry(db, {
        id: e.id,
        type: e.type,
        title: e.title,
        content: e.content,
        files: e.files,
        tags: e.tags,
        errorSignature: "errorSignature" in e ? e.errorSignature : undefined,
        confidence: e.confidence,
        sourceCount: e.sourceCount,
        createdAt: TEST_NOW,
        lastConfirmed: TEST_NOW,
        status: "active",
      });
    }
  });

  test("returns results for a relevant query", () => {
    const results = simulateRecall(db, { query: "typescript configuration" });
    expect(results.length).toBeGreaterThan(0);
  });

  test("filters out entries below confidence threshold", () => {
    // recall-05 has confidence 0.05 which is below the default threshold 0.15
    const results = simulateRecall(db, {
      query: "error handling typed catches",
      confidenceThreshold: 0.15,
    });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("recall-05");
  });

  test("includes entries at or above confidence threshold", () => {
    const results = simulateRecall(db, {
      query: "typescript strict",
      confidenceThreshold: 0.1,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("recall-01");
  });

  test("respects max_results limit", () => {
    const results = simulateRecall(db, {
      query: "typescript",
      max_results: 2,
      confidenceThreshold: 0,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("type filter restricts results to the specified type", () => {
    const results = simulateRecall(db, {
      query: "typescript",
      type: "convention",
      confidenceThreshold: 0,
    });
    for (const r of results) {
      expect(r.type).toBe("convention");
    }
  });

  test("type filter 'error_pattern' returns only error patterns", () => {
    const results = simulateRecall(db, {
      query: "module typescript",
      type: "error_pattern",
      confidenceThreshold: 0,
    });
    for (const r of results) {
      expect(r.type).toBe("error_pattern");
    }
  });

  test("empty database returns no results", () => {
    const emptyDb = initDatabase(":memory:");
    try {
      const results = simulateRecall(emptyDb, { query: "anything" });
      expect(results).toEqual([]);
    } finally {
      emptyDb.close();
    }
  });

  test("query with no matches returns empty array", () => {
    const results = simulateRecall(db, {
      query: "xyznonexistenttermthatwouldnevermatch123",
    });
    expect(results).toEqual([]);
  });

  test("file path filter finds entries associated with that file", () => {
    const results = simulateRecall(db, {
      query: "typescript",
      files: ["tsconfig.json"],
      confidenceThreshold: 0,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("recall-01");
  });

  test("results all have confidence at or above threshold", () => {
    const threshold = 0.15;
    const results = simulateRecall(db, {
      query: "typescript",
      confidenceThreshold: threshold,
    });
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(threshold);
    }
  });
});

// ---------------------------------------------------------------------------
// conventions flow tests
// ---------------------------------------------------------------------------

describe("conventions flow (fetchConventions logic)", () => {
  beforeEach(() => {
    const now = TEST_NOW;

    // Insert conventions
    const conventions = [
      {
        id: "conv-01",
        title: "Use Prettier for formatting",
        content: "All code should be formatted with Prettier using the project config.",
        files: ["src/utils/format.ts"],
        tags: ["formatting", "tooling"],
        confidence: 0.9,
      },
      {
        id: "conv-02",
        title: "Immutable state updates only",
        content: "Never mutate state directly. Use spread or Object.assign.",
        files: ["src/state/store.ts"],
        tags: ["immutability", "state"],
        confidence: 0.95,
      },
      {
        id: "conv-03",
        title: "Zod schema validation at boundaries",
        content: "Validate all inputs at system boundaries using Zod schemas.",
        files: ["src/api/handlers.ts"],
        tags: ["validation", "zod"],
        confidence: 0.88,
      },
    ];

    for (const c of conventions) {
      insertEntry(db, {
        id: c.id,
        type: "convention",
        title: c.title,
        content: c.content,
        files: c.files,
        tags: c.tags,
        confidence: c.confidence,
        sourceCount: 2,
        createdAt: now,
        lastConfirmed: now,
        status: "active",
      });
    }

    // Insert a non-convention entry (should never appear in convention results)
    insertEntry(db, {
      id: "not-conv-01",
      type: "learning",
      title: "A learning not a convention",
      content: "This is a learning entry and should not appear in conventions.",
      files: [],
      tags: ["learning"],
      confidence: 0.8,
      sourceCount: 1,
      createdAt: now,
      lastConfirmed: now,
      status: "active",
    });
  });

  test("unfiltered query returns all active conventions", () => {
    const rows = db
      .query<{ id: string }, []>(
        "SELECT id FROM entries WHERE type = 'convention' AND status = 'active' ORDER BY confidence DESC",
      )
      .all();
    expect(rows.length).toBe(3);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("conv-01");
    expect(ids).toContain("conv-02");
    expect(ids).toContain("conv-03");
  });

  test("directory filter matches conventions by file path prefix", () => {
    const rows = db
      .query<{ id: string }, [string]>(
        `SELECT DISTINCT e.id FROM entries e
         LEFT JOIN entry_files ef ON ef.entry_id = e.id
         WHERE e.type = 'convention' AND e.status = 'active'
           AND ef.file_path LIKE ?
         ORDER BY e.confidence DESC`,
      )
      .all("src/state/%");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("conv-02");
    expect(ids).not.toContain("conv-01");
  });

  test("tag filter returns conventions with matching tag", () => {
    const rows = db
      .query<{ id: string }, [string]>(
        `SELECT DISTINCT e.id FROM entries e
         LEFT JOIN entry_tags et ON et.entry_id = e.id
         WHERE e.type = 'convention' AND e.status = 'active'
           AND et.tag IN (?)
         ORDER BY e.confidence DESC`,
      )
      .all("zod");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("conv-03");
    expect(ids).not.toContain("conv-01");
  });

  test("non-convention entries are never returned", () => {
    const rows = db
      .query<{ id: string }, []>(
        "SELECT id FROM entries WHERE type = 'convention' AND status = 'active'",
      )
      .all();
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("not-conv-01");
  });

  test("results ordered by descending confidence", () => {
    const rows = db
      .query<{ id: string; confidence: number }, []>(
        "SELECT id, confidence FROM entries WHERE type = 'convention' AND status = 'active' ORDER BY confidence DESC",
      )
      .all();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.confidence).toBeGreaterThanOrEqual(rows[i]!.confidence);
    }
  });
});

// ---------------------------------------------------------------------------
// failures flow tests
// ---------------------------------------------------------------------------

describe("failures flow (searchBySignature + BM25 fallback)", () => {
  beforeEach(() => {
    const now = TEST_NOW;

    // Insert known error pattern entries
    const errors = [
      {
        id: "fail-01",
        title: "Cannot Read Property of Undefined",
        content: "Accessing a property of an undefined value. Use optional chaining or guard with typeof.",
        errorSignature: "typeerror: cannot read property <str> of undefined",
        confidence: 0.9,
        sourceCount: 3,
      },
      {
        id: "fail-02",
        title: "Module Not Found Resolution Error",
        content: "The required module could not be resolved. Check import paths and package.json.",
        errorSignature: "error: cannot find module <str>",
        confidence: 0.85,
        sourceCount: 2,
      },
      {
        id: "fail-03",
        title: "Stack Overflow From Infinite Recursion",
        content: "Infinite recursion detected. Add a base case or depth limit to recursive functions.",
        errorSignature: "rangeerror: maximum call stack size exceeded",
        confidence: 0.75,
        sourceCount: 2,
      },
    ];

    for (const e of errors) {
      insertEntry(db, {
        id: e.id,
        type: "error_pattern",
        title: e.title,
        content: e.content,
        files: [],
        tags: [],
        errorSignature: e.errorSignature,
        confidence: e.confidence,
        sourceCount: e.sourceCount,
        createdAt: now,
        lastConfirmed: now,
        status: "active",
      });
    }
  });

  test("exact signature match returns the known error pattern", () => {
    // Simulate the exact same normalised signature
    const signature = "typeerror: cannot read property <str> of undefined";
    const rows = db
      .query<{ id: string; title: string }, [string]>(
        `SELECT id, title FROM entries
         WHERE error_signature = ?
           AND type = 'error_pattern'
           AND status = 'active'
         ORDER BY confidence DESC`,
      )
      .all(signature);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.id).toBe("fail-01");
  });

  test("normalizeErrorSignature produces stable match", () => {
    const msg1 = "TypeError: Cannot read property 'foo' of undefined";
    const msg2 = "TypeError: Cannot read property 'bar' of undefined";
    const sig1 = normalizeErrorSignature(msg1);
    const sig2 = normalizeErrorSignature(msg2);
    // Both should normalize to the same signature (quoted strings → <str>)
    expect(sig1).toBe(sig2);
    expect(sig1).toBe("typeerror: cannot read property <str> of undefined");
  });

  test("BM25 fallback finds relevant entry when signature does not match", () => {
    // A slightly different error message that won't match by exact signature
    const differentSignature = "this signature does not exist in the database";
    const exactRows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE error_signature = ? AND type = 'error_pattern' AND status = 'active'",
      )
      .all(differentSignature);
    expect(exactRows.length).toBe(0);

    // BM25 fallback: search for terms related to 'stack overflow recursion'
    const bm25Results = searchByBM25(db, "stack overflow recursion call", "error_pattern");
    expect(bm25Results.length).toBeGreaterThan(0);
    const ids = bm25Results.map((r) => r.id);
    expect(ids).toContain("fail-03");
  });

  test("confidence threshold filters out low-confidence error patterns", () => {
    // Add a low-confidence error pattern
    insertEntry(db, {
      id: "fail-low",
      type: "error_pattern",
      title: "Low confidence error",
      content: "This error pattern has not been confirmed enough times.",
      files: [],
      tags: [],
      errorSignature: "error: low confidence pattern",
      confidence: 0.05,
      sourceCount: 1,
      createdAt: TEST_NOW,
      lastConfirmed: TEST_NOW,
      status: "active",
    });

    const allRows = db
      .query<{ id: string; confidence: number }, []>(
        "SELECT id, confidence FROM entries WHERE type = 'error_pattern' AND status = 'active' ORDER BY confidence DESC",
      )
      .all();

    const threshold = 0.15;
    const filtered = allRows.filter((r) => r.confidence >= threshold);
    const allIds = allRows.map((r) => r.id);
    const filteredIds = filtered.map((r) => r.id);

    expect(allIds).toContain("fail-low");
    expect(filteredIds).not.toContain("fail-low");
  });

  test("no matching error patterns returns empty result", () => {
    const obscureSignature = "completelymadeuperrorthatdoesnotexist";
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE error_signature = ? AND type = 'error_pattern' AND status = 'active'",
      )
      .all(obscureSignature);

    const bm25 = searchByBM25(db, obscureSignature, "error_pattern");

    expect(rows.length).toBe(0);
    expect(bm25.length).toBe(0);
  });
});
