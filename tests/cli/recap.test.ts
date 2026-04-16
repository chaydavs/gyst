import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../src/store/database.js";
import { renderRecap } from "../../src/cli/recap.js";

describe("renderRecap", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gyst-recap-"));
    dbPath = join(tmpDir, ".wiki.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("renders empty recap when no activity", () => {
    const db = initDatabase(dbPath);
    const recap = renderRecap(db, { sinceMinutes: 10 });
    
    expect(recap).toContain("# Session recap");
    expect(recap).toContain("Window: last 10 minutes");
    expect(recap).toContain("Prompts: 0");
    expect(recap).toContain("_no activity in this window_");
    
    db.close();
  });

  test("renders counts from event_queue", () => {
    const db = initDatabase(dbPath);
    
    // Insert some events
    db.run("INSERT INTO event_queue (type, payload) VALUES ('prompt', '{}')");
    db.run("INSERT INTO event_queue (type, payload) VALUES ('tool_use', '{}')");
    db.run("INSERT INTO event_queue (type, payload) VALUES ('tool_use', '{}')");
    
    const recap = renderRecap(db, { sinceMinutes: 10 });
    
    expect(recap).toContain("Prompts: 1");
    expect(recap).toContain("Tool calls: 2");
    expect(recap).not.toContain("_no activity in this window_");
    
    db.close();
  });

  test("renders new entries from entries table", () => {
    const db = initDatabase(dbPath);
    
    db.run(
      `INSERT INTO entries
         (id, type, title, content, confidence, source_count,
          source_tool, created_at, last_confirmed, status, scope)
       VALUES (?, ?, ?, 'body', 0.7, 1,
               'test', datetime('now'), datetime('now'), 'active', 'team')`,
      ["entry-1", "decision", "Decided to use Bun"],
    );
    
    const recap = renderRecap(db, { sinceMinutes: 10 });
    
    expect(recap).toContain("## New entries");
    expect(recap).toContain("- (decision) Decided to use Bun");
    
    db.close();
  });
});
