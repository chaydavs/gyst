import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../src/store/database.js";
import { exportToMarkdown } from "../../src/cli/export.js";
import type { Config } from "../../src/utils/config.js";

describe("exportToMarkdown", () => {
  let tmpDir: string;
  let wikiDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gyst-export-"));
    wikiDir = join(tmpDir, "gyst-wiki");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("writes one markdown file per active entry", async () => {
    const db = initDatabase(join(tmpDir, ".wiki.db"));
    const config = { wikiDir } as unknown as Config;

    for (const [id, title, status] of [
      ["exp-001", "Active entry A", "active"],
      ["exp-002", "Active entry B", "active"],
      ["exp-003", "Archived entry", "archived"],
    ]) {
      db.run(
        `INSERT INTO entries
           (id, type, title, content, file_path, confidence, source_count,
            source_tool, created_at, last_confirmed, status, scope)
         VALUES (?, 'learning', ?, 'body', null, 0.7, 1,
                 'test', datetime('now'), datetime('now'), ?, 'team')`,
        [id, title, status],
      );
    }

    const result = await exportToMarkdown(db, config);

    expect(result.exported).toBe(2); // only active entries
    expect(result.skipped).toBe(0);

    const mdFiles = readdirSync(wikiDir, { recursive: true })
      .filter((f) => String(f).endsWith(".md") && !String(f).endsWith("index.md"));
    expect(mdFiles).toHaveLength(2);

    db.close();
  });

  test("updates markdown_path in DB after writing", async () => {
    const db = initDatabase(join(tmpDir, ".wiki.db"));
    const config = { wikiDir } as unknown as Config;

    db.run(
      `INSERT INTO entries
         (id, type, title, content, file_path, confidence, source_count,
          source_tool, created_at, last_confirmed, status, scope)
       VALUES ('exp-path-001', 'learning', 'Path test', 'body', null, 0.7, 1,
               'test', datetime('now'), datetime('now'), 'active', 'team')`,
    );

    await exportToMarkdown(db, config);

    const row = db
      .query<{ markdown_path: string | null }, []>(
        "SELECT markdown_path FROM entries WHERE id = 'exp-path-001'",
      )
      .get();
    expect(row?.markdown_path).not.toBeNull();
    expect(existsSync(row!.markdown_path!)).toBe(true);

    db.close();
  });

  test("skips entries whose markdown file already exists", async () => {
    const db = initDatabase(join(tmpDir, ".wiki.db"));
    const config = { wikiDir } as unknown as Config;

    const existingPath = join(wikiDir, "learning", "existing-exp-exist01.md");
    mkdirSync(join(wikiDir, "learning"), { recursive: true });
    writeFileSync(existingPath, "# existing\n", "utf8");

    db.run(
      `INSERT INTO entries
         (id, type, title, content, file_path, confidence, source_count,
          source_tool, created_at, last_confirmed, status, scope, markdown_path)
       VALUES ('exp-exist01', 'learning', 'Existing', 'body', null, 0.7, 1,
               'test', datetime('now'), datetime('now'), 'active', 'team', ?)`,
      [existingPath],
    );

    const result = await exportToMarkdown(db, config);

    expect(result.skipped).toBe(1);
    expect(result.exported).toBe(0);

    db.close();
  });
});
