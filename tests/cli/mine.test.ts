import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getMiningCursor, setMiningCursor, shouldSkipCommitSubject, conventionalTypeToEntryType, mineGitPhase, mineCommentsPhase } from "../../src/cli/commands/mine.js";
import { initDatabase } from "../../src/store/database.js";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("shouldSkipCommitSubject", () => {
  it("skips chore/bump/merge/revert subjects", () => {
    expect(shouldSkipCommitSubject("chore: update deps")).toBe(true);
    expect(shouldSkipCommitSubject("bump: v1.2.3")).toBe(true);
    expect(shouldSkipCommitSubject("Merge branch 'main'")).toBe(true);
    expect(shouldSkipCommitSubject("revert: undo change")).toBe(true);
  });

  it("keeps feat/fix/refactor subjects", () => {
    expect(shouldSkipCommitSubject("feat: add login")).toBe(false);
    expect(shouldSkipCommitSubject("fix: null crash")).toBe(false);
    expect(shouldSkipCommitSubject("refactor: clean up auth")).toBe(false);
  });
});

describe("conventionalTypeToEntryType", () => {
  it("maps feat/refactor to decision", () => {
    expect(conventionalTypeToEntryType("feat")).toBe("decision");
    expect(conventionalTypeToEntryType("refactor")).toBe("decision");
  });

  it("maps fix/perf to learning", () => {
    expect(conventionalTypeToEntryType("fix")).toBe("learning");
    expect(conventionalTypeToEntryType("perf")).toBe("learning");
  });

  it("maps docs/test to convention", () => {
    expect(conventionalTypeToEntryType("docs")).toBe("convention");
    expect(conventionalTypeToEntryType("test")).toBe("convention");
  });

  it("falls back to learning for unknown types", () => {
    expect(conventionalTypeToEntryType("other")).toBe("learning");
  });
});

describe("mineGitPhase", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gyst-mine-git-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 when not inside a git repo", async () => {
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    const count = await mineGitPhase(db, { full: false, noLlm: true, repoRoot: tmpDir });
    db.close();
    expect(count).toBe(0);
  });
});

describe("mineCommentsPhase", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gyst-mine-comments-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts TODO/FIXME/NOTE comments from src/", async () => {
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "example.ts"), [
      "// TODO: refactor this when we upgrade to v2",
      "const x = 1;",
      "// FIXME: this breaks on Windows paths",
      "const y = 2;",
      "// NOTE: this must run before the DB is initialised",
    ].join("\n"));
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    const count = await mineCommentsPhase(db, { full: false, noLlm: true, repoRoot: tmpDir });
    db.close();
    expect(count).toBe(3);
  });

  it("deduplicates identical comments on re-run", async () => {
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "a.ts"), "// TODO: same comment\n");
    const db = await initDatabase(join(tmpDir, "wiki.db"));
    await mineCommentsPhase(db, { full: false, noLlm: true, repoRoot: tmpDir });
    const count = await mineCommentsPhase(db, { full: false, noLlm: true, repoRoot: tmpDir });
    db.close();
    expect(count).toBe(0);
  });
});
