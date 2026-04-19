import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getMiningCursor, setMiningCursor } from "../../src/cli/commands/mine.js";
import { initDatabase } from "../../src/store/database.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("mining cursor helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gyst-mine-cursor-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getMiningCursor returns null when key absent", async () => {
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    const result = getMiningCursor(db, "last_commit_hash");
    db.close();
    expect(result).toBeNull();
  });

  it("setMiningCursor + getMiningCursor round-trips", async () => {
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    setMiningCursor(db, "last_commit_hash", "abc123def456");
    const result = getMiningCursor(db, "last_commit_hash");
    db.close();
    expect(result).toBe("abc123def456");
  });

  it("setMiningCursor updates existing key", async () => {
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    setMiningCursor(db, "last_commit_hash", "first");
    setMiningCursor(db, "last_commit_hash", "second");
    const result = getMiningCursor(db, "last_commit_hash");
    db.close();
    expect(result).toBe("second");
  });
});
