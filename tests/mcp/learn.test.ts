/**
 * Tests for the autoExport gate in learn.ts persistEntry.
 *
 * Verifies:
 *  - No markdown files are written when autoExport is false (default)
 *  - Markdown file is written and entries.markdown_path is populated when autoExport is true
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../src/store/database.js";
import { persistEntry } from "../../src/mcp/tools/learn.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EntryPathRow = { markdown_path: string | null };

const TEST_NOW = new Date("2026-04-15T00:00:00.000Z").toISOString();

function makeEntry(id: string) {
  return {
    id,
    type: "learning" as const,
    title: "Test autoExport gating",
    content: "This is a test entry to verify autoExport behaviour.",
    errorSignature: undefined,
    fingerprint: undefined,
    confidence: 0.5,
    sourceCount: 1,
    files: [],
    tags: [],
    now: TEST_NOW,
    scope: "team" as const,
    metadata: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpWikiDir: string;

beforeEach(() => {
  tmpWikiDir = mkdtempSync(join(tmpdir(), "gyst-learn-test-"));
});

afterEach(() => {
  rmSync(tmpWikiDir, { recursive: true, force: true });
});

test("learn: does NOT write markdown when autoExport is false (default)", () => {
  const db = initDatabase(":memory:");
  const id = crypto.randomUUID();

  persistEntry(db, makeEntry(id), tmpWikiDir);

  // No .md files should exist in wikiDir
  const files = readdirSync(tmpWikiDir, { recursive: true });
  const mdFiles = (files as string[]).filter((f) => f.endsWith(".md"));
  expect(mdFiles).toHaveLength(0);

  // DB row should exist with markdown_path = null
  const row = db
    .query<EntryPathRow, [string]>("SELECT markdown_path FROM entries WHERE id = ?")
    .get(id);
  expect(row).not.toBeNull();
  expect(row!.markdown_path).toBeNull();
});

test("learn: writes markdown AND sets markdown_path when autoExport is true", () => {
  const db = initDatabase(":memory:");
  const id = crypto.randomUUID();

  persistEntry(db, makeEntry(id), tmpWikiDir, true);

  // At least one .md file should exist in wikiDir
  const files = readdirSync(tmpWikiDir, { recursive: true });
  const mdFiles = (files as string[]).filter((f) =>
    typeof f === "string" && f.endsWith(".md"),
  );
  expect(mdFiles.length).toBeGreaterThan(0);

  // DB row should have markdown_path pointing to an existing file
  const row = db
    .query<EntryPathRow, [string]>("SELECT markdown_path FROM entries WHERE id = ?")
    .get(id);
  expect(row).not.toBeNull();
  expect(row!.markdown_path).not.toBeNull();
  expect(existsSync(row!.markdown_path!)).toBe(true);
});
