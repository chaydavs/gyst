/**
 * Tests for generateOnboarding() — reads entries from an in-memory SQLite DB
 * and asserts on the produced markdown string.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { generateOnboarding } from "../../src/cli/onboard.js";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory SQLite database with the Gyst schema applied.
 */
function makeDb(): Database {
  return initDatabase(":memory:");
}

/**
 * Inserts a minimal entry row directly via SQL.
 * Uses the same column set required by the entries table.
 */
function insertEntry(
  db: Database,
  opts: {
    id: string;
    type: string;
    title: string;
    content: string;
    confidence: number;
    status?: string;
    createdAt?: string;
  },
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO entries
      (id, type, title, content, confidence, scope, status, created_at, last_confirmed, source_count)
     VALUES (?, ?, ?, ?, ?, 'team', ?, ?, ?, 0)`,
    [
      opts.id,
      opts.type,
      opts.title,
      opts.content,
      opts.confidence,
      opts.status ?? "active",
      opts.createdAt ?? now,
      now,
    ],
  );
}

/**
 * Attaches a tag to an existing entry.
 */
function insertTag(db: Database, entryId: string, tag: string): void {
  db.run("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)", [entryId, tag]);
}

// ---------------------------------------------------------------------------
// Shared seed data
// ---------------------------------------------------------------------------

/**
 * Seeds the DB with:
 *  - 2 ghost_knowledge entries
 *  - 4 conventions (naming, imports, error_handling, exports categories)
 *  - 2 decisions
 *  - 1 error_pattern
 */
function seedDb(db: Database): void {
  // Ghost knowledge
  insertEntry(db, {
    id: "ghost-1",
    type: "ghost_knowledge",
    title: "Never push to main on Fridays",
    content: "Never push to main on Fridays. Deployments freeze from noon Friday to Monday.",
    confidence: 1.0,
  });
  insertEntry(db, {
    id: "ghost-2",
    type: "ghost_knowledge",
    title: "PR approval from platform team required",
    content: "PR approval from platform team required for any infra changes. No exceptions.",
    confidence: 1.0,
  });

  // Conventions
  insertEntry(db, {
    id: "conv-naming",
    type: "convention",
    title: "camelCase for all exported functions",
    content: "All exported functions use camelCase naming.",
    confidence: 0.95,
  });
  insertTag(db, "conv-naming", "category:naming");

  insertEntry(db, {
    id: "conv-imports",
    type: "convention",
    title: "Relative imports for internal modules",
    content: "Always use relative imports for internal modules.",
    confidence: 0.88,
  });
  insertTag(db, "conv-imports", "category:imports");

  insertEntry(db, {
    id: "conv-errors",
    type: "convention",
    title: "Wrap external calls in try/catch",
    content: "Always wrap external calls in try/catch with typed error handling.",
    confidence: 0.82,
  });
  insertTag(db, "conv-errors", "category:error_handling");

  insertEntry(db, {
    id: "conv-exports",
    type: "convention",
    title: "Named exports only, no default exports",
    content: "Use named exports everywhere. Default exports are banned.",
    confidence: 0.79,
  });
  insertTag(db, "conv-exports", "category:exports");

  // Decisions
  insertEntry(db, {
    id: "dec-1",
    type: "decision",
    title: "Chose Bun over Node for native SQLite",
    content: "We chose Bun because it ships bun:sqlite and starts faster.",
    confidence: 0.9,
    createdAt: "2024-01-15T10:00:00.000Z",
  });
  insertEntry(db, {
    id: "dec-2",
    type: "decision",
    title: "FTS5 with porter stemmer for keyword search",
    content: "FTS5 gives us BM25 ranking without external dependencies.",
    confidence: 0.9,
    createdAt: "2024-02-20T10:00:00.000Z",
  });

  // Error pattern
  insertEntry(db, {
    id: "err-1",
    type: "error_pattern",
    title: "SQLite UNIQUE constraint on entry_tags",
    content: "Inserting duplicate entry_tags rows crashes. Always use INSERT OR IGNORE.",
    confidence: 0.85,
  });
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "gyst-onboard-test-"));
  return tempDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateOnboarding", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  test("output contains all required section headings", () => {
    seedDb(db);
    const dir = makeTempDir();
    const output = generateOnboarding(db, { dir });

    expect(output).toContain("# Onboarding");
    expect(output).toContain("## Team Rules");
    expect(output).toContain("## Conventions");
    expect(output).toContain("## Recent Decisions");
    expect(output).toContain("## Error Patterns");
    expect(output).toContain("## Getting Started");
  });

  test("ghost entries appear in Team Rules section", () => {
    seedDb(db);
    const dir = makeTempDir();
    const output = generateOnboarding(db, { dir });

    // Find position of the Team Rules heading
    const teamRulesIdx = output.indexOf("## Team Rules");
    const nextSectionIdx = output.indexOf("## Conventions");
    expect(teamRulesIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(teamRulesIdx);

    const teamRulesSection = output.slice(teamRulesIdx, nextSectionIdx);
    expect(teamRulesSection).toContain("Never push to main on Fridays");
    expect(teamRulesSection).toContain("PR approval from platform team required");
  });

  test("convention categories are grouped and naming category appears", () => {
    seedDb(db);
    const dir = makeTempDir();
    const output = generateOnboarding(db, { dir });

    // Naming category sub-heading
    expect(output).toContain("### Naming");
    // The naming convention title should appear under it
    const namingIdx = output.indexOf("### Naming");
    const afterNaming = output.slice(namingIdx);
    // The entry should appear before the next ### or ##
    const nextHeadingIdx = afterNaming.search(/\n##/);
    const namingBlock =
      nextHeadingIdx === -1 ? afterNaming : afterNaming.slice(0, nextHeadingIdx);
    expect(namingBlock).toContain("camelCase for all exported functions");
  });

  test("decisions appear in Recent Decisions section", () => {
    seedDb(db);
    const dir = makeTempDir();
    const output = generateOnboarding(db, { dir });

    const decisionsIdx = output.indexOf("## Recent Decisions");
    const afterDecisions = output.slice(decisionsIdx);
    expect(afterDecisions).toContain("Chose Bun over Node for native SQLite");
    expect(afterDecisions).toContain("FTS5 with porter stemmer for keyword search");
  });

  test("error pattern appears in Error Patterns section", () => {
    seedDb(db);
    const dir = makeTempDir();
    const output = generateOnboarding(db, { dir });

    const errorIdx = output.indexOf("## Error Patterns");
    const afterErrors = output.slice(errorIdx);
    expect(afterErrors).toContain("SQLite UNIQUE constraint on entry_tags");
  });

  test("empty DB produces all fallback strings and does not crash", () => {
    const dir = makeTempDir();
    // DB has no entries
    const output = generateOnboarding(db, { dir });

    expect(output).toContain("_(No team rules defined yet.)_");
    expect(output).toContain("_(No conventions detected yet.");
    expect(output).toContain("_(No decisions recorded yet.)_");
    expect(output).toContain("_(No error patterns recorded yet.)_");
  });

  test("dir with no package.json uses default commands and does not crash", () => {
    seedDb(db);
    const dir = makeTempDir();
    // tempDir exists but has no package.json — defaults should appear

    const output = generateOnboarding(db, { dir });

    expect(output).toContain("## Getting Started");
    expect(output).toContain("`bun install`");
    expect(output).toContain("`bun run dev`");
    expect(output).toContain("`bun test`");
    expect(output).toContain("`bun run build`");
  });

  test("project name is read from package.json name field", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-project" }), "utf-8");

    const output = generateOnboarding(db, { dir });

    expect(output).toContain("# Onboarding: test-project");
  });

  test("project name falls back to basename when package.json is missing", () => {
    const dir = makeTempDir();
    // No package.json written — should fall back to the dir's basename

    const output = generateOnboarding(db, { dir });

    const dirBasename = dir.split("/").pop() ?? "";
    expect(output).toContain(`# Onboarding: ${dirBasename}`);
  });
});
