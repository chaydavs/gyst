import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDatabase } from "../../src/store/database.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("codebase_mining_state table", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gyst-mine-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("table is created on db init", async () => {
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    const row = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='codebase_mining_state'"
    ).get();
    db.close();
    expect(row).not.toBeNull();
    expect(row!.name).toBe("codebase_mining_state");
  });

  it("can read/write cursor keys", async () => {
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    db.run("INSERT OR REPLACE INTO codebase_mining_state (key, value) VALUES (?, ?)", ["last_commit_hash", "abc123"]);
    const row = db.query<{ value: string }, [string]>(
      "SELECT value FROM codebase_mining_state WHERE key = ?"
    ).get("last_commit_hash");
    db.close();
    expect(row?.value).toBe("abc123");
  });
});
