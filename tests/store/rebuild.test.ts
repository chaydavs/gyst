/**
 * Tests for rebuild.ts — importing markdown entries into the database.
 * All tests use `:memory:` so no files are created on disk.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../src/store/database.js";
import { rebuildFromMarkdown } from "../../src/store/rebuild.js";
import type { Config } from "../../src/utils/config.js";

describe("rebuild", () => {
  test("rebuild does not overwrite an existing DB entry", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gyst-rebuild-"));
    const wikiDir = join(tmpDir, "gyst-wiki");
    const mdDir = join(wikiDir, "learning");
    mkdirSync(mdDir, { recursive: true });
    const db = initDatabase(join(tmpDir, ".wiki.db"));

    // Write a markdown file that would produce id "test-preserve-01" on rebuild
    const mdContent = `---
id: test-preserve-01
type: learning
title: Original from markdown
confidence: 0.7
created_at: "2025-01-01T00:00:00.000Z"
last_confirmed: "2025-01-01T00:00:00.000Z"
tags: []
affects: []
---
# Original from markdown
Body text.
`;
    writeFileSync(join(mdDir, "original-test-preserve-01.md"), mdContent, "utf8");

    // Pre-insert the same ID with different data (simulates live DB entry)
    db.run(
      `INSERT INTO entries
         (id, type, title, content, file_path, confidence, source_count,
          source_tool, created_at, last_confirmed, status, scope)
       VALUES ('test-preserve-01', 'learning', 'Live DB title', 'live body',
               null, 0.9, 5, 'mcp', datetime('now'), datetime('now'), 'active', 'team')`,
    );

    // Run rebuild — should not overwrite the live DB entry
    const config: Config = {
      wikiDir,
      dbPath: join(tmpDir, ".wiki.db"),
      globalDbPath: join(tmpDir, "global.db"),
      maxRecallTokens: 5000,
      confidenceThreshold: 0.15,
      logLevel: "info" as const,
      autoExport: false,
    };
    await rebuildFromMarkdown(config);

    const row = db
      .query<{ title: string; confidence: number }, []>(
        "SELECT title, confidence FROM entries WHERE id = 'test-preserve-01'",
      )
      .get();
    expect(row?.title).toBe("Live DB title");
    expect(row?.confidence).toBe(0.9);

    db.close();
    rmSync(tmpDir, { recursive: true });
  });
});
