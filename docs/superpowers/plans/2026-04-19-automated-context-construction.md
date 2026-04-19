# Automated Context Construction (gyst mine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `gyst mine` — a four-phase command that automatically extracts institutional knowledge from git history, code comments, hot paths, and integration tests, running incrementally on every session start/end.

**Architecture:** New `src/cli/commands/mine.ts` handles all four phases with a `codebase_mining_state` cursor table tracking progress. The command is wired as a fire-and-forget detached spawn in existing plugin hook scripts and the git post-commit hook.

**Tech Stack:** TypeScript · Bun · bun:sqlite · simple-git · node:child_process (spawnSync with array args — no shell injection) · existing `addManualEntry()` write path

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/store/database.ts` | Modify | Add `codebase_mining_state` DDL to `DDL_STATEMENTS` array |
| `src/cli/commands/mine.ts` | Create | All four phases + cursor read/write |
| `src/cli/index.ts` | Modify | Register `gyst mine` command with `--commit`, `--full`, `--no-llm` flags |
| `plugin/scripts/session-start.js` | Modify | Add `mine --no-llm` detached spawn after `self-document` spawn |
| `plugin/scripts/session-end.js` | Modify | Add `mine --no-llm` detached spawn after `self-document` spawn |
| `plugin/scripts/pre-compact.js` | Modify | Add `mine --no-llm` detached spawn alongside existing harvest |
| `src/capture/git-hook.ts` | Modify | Add `mine --commit HEAD` detached spawn after `captureCommit()` |
| `README.md` | Modify | Add "Automated Context Construction" section + update Hooks table + CLI table |
| `plugin/WORKFLOW.md` | Modify | Add mine trigger points to autonomous loop section |
| `tests/cli/mine.test.ts` | Create | Unit tests for each phase function |

---

### Task 1: Add `codebase_mining_state` table to database schema

**Files:**
- Modify: `src/store/database.ts` (find `DDL_STATEMENTS` array around line 143)
- Test: `tests/store/mining-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/store/mining-state.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/store/mining-state.test.ts
```
Expected: FAIL — `codebase_mining_state` table does not exist yet.

- [ ] **Step 3: Add DDL to `src/store/database.ts`**

Find the `DDL_STATEMENTS` array (around line 143). Add this entry after the `consolidation_state` entry:

```typescript
  `CREATE TABLE IF NOT EXISTS codebase_mining_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/store/mining-state.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Run full lint**

```bash
bun run lint
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/database.ts tests/store/mining-state.test.ts
git commit -m "feat(mine): add codebase_mining_state cursor table"
```

---

### Task 2: Create `src/cli/commands/mine.ts` — skeleton + cursor helpers

**Files:**
- Create: `src/cli/commands/mine.ts`
- Test: `tests/cli/mine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/mine.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/mine.test.ts
```
Expected: FAIL — `mine.js` module not found.

- [ ] **Step 3: Create `src/cli/commands/mine.ts` with types and cursor helpers**

```typescript
/**
 * gyst mine — automated institutional knowledge extraction.
 *
 * Four phases:
 *  1. git      — commit messages from last_commit_hash to HEAD
 *  2. comments — TODO/FIXME/NOTE/HACK/Why: markers across src/
 *  3. hotpaths — top-20 most-edited files from git log
 *  4. tests    — top-level describe() names from integration/e2e/spec files
 */

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { logger } from "../../utils/logger.js";
import { initDatabase } from "../../store/database.js";
import { loadConfig } from "../../utils/config.js";
import { addManualEntry } from "../../capture/manual.js";

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/** Reads a mining cursor value (returns null when key absent). */
export function getMiningCursor(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM codebase_mining_state WHERE key = ?"
    )
    .get(key);
  return row?.value ?? null;
}

/** Upserts a mining cursor value. */
export function setMiningCursor(db: Database, key: string, value: string): void {
  db.run(
    "INSERT OR REPLACE INTO codebase_mining_state (key, value) VALUES (?, ?)",
    [key, value]
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Returns the first 16 hex chars of SHA-256(s). Used for dedup fingerprints. */
export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MineOptions {
  readonly commitHash?: string;
  readonly full: boolean;
  readonly noLlm: boolean;
  readonly repoRoot: string;
}

export interface MineResult {
  readonly git: number;
  readonly comments: number;
  readonly hotpaths: number;
  readonly tests: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/cli/mine.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mine.ts tests/cli/mine.test.ts
git commit -m "feat(mine): skeleton + cursor helpers"
```

---

### Task 3: Implement Phase 1 — git commit message mining

**Files:**
- Modify: `src/cli/commands/mine.ts`
- Modify: `tests/cli/mine.test.ts`

- [ ] **Step 1: Add git phase tests**

Append to `tests/cli/mine.test.ts`:

```typescript
import { shouldSkipCommitSubject, conventionalTypeToEntryType, mineGitPhase } from "../../src/cli/commands/mine.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/mine.test.ts --testNamePattern "shouldSkipCommit|conventionalType|mineGitPhase"
```
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add git phase to `src/cli/commands/mine.ts`**

Add after the `MineResult` interface:

```typescript
// ---------------------------------------------------------------------------
// Phase 1: git commit message mining
// ---------------------------------------------------------------------------

const SKIP_SUBJECT_RE = /^(chore|bump|merge|revert)[:(]/i;

export function shouldSkipCommitSubject(subject: string): boolean {
  const trimmed = subject.trim();
  return SKIP_SUBJECT_RE.test(trimmed) || /^merge\b/i.test(trimmed);
}

const CC_TYPE_MAP: Record<string, "decision" | "learning" | "convention"> = {
  feat: "decision",
  refactor: "decision",
  fix: "learning",
  perf: "learning",
  docs: "convention",
  test: "convention",
};

export function conventionalTypeToEntryType(
  ccType: string
): "decision" | "learning" | "convention" {
  return CC_TYPE_MAP[ccType.toLowerCase()] ?? "learning";
}

export async function mineGitPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash"> & { commitHash?: string }
): Promise<number> {
  let count = 0;
  try {
    const { default: simpleGit } = await import("simple-git");
    const git = simpleGit(opts.repoRoot);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) return 0;

    const cursor = opts.full ? null : getMiningCursor(db, "last_commit_hash");

    const logArgs: string[] = ["log", "--format=%H|%s|%b|%ai|%an", "--no-merges"];
    if (opts.commitHash) {
      logArgs.push(opts.commitHash, "-1");
    } else if (cursor) {
      logArgs.push(`${cursor}..HEAD`);
    }

    const rawLog = await git.raw(logArgs);
    if (!rawLog.trim()) return 0;

    for (const line of rawLog.trim().split("\n")) {
      const pipeIdx = line.indexOf("|");
      if (pipeIdx === -1) continue;
      const hash = line.slice(0, pipeIdx);
      const parts = line.slice(pipeIdx + 1).split("|");
      const subject = parts[0]?.trim() ?? "";
      const body = parts[1]?.trim() ?? "";
      const author = parts[3]?.trim() ?? "";

      if (!hash || shouldSkipCommitSubject(subject)) continue;

      const alreadyStored = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM entries WHERE content LIKE ? LIMIT 1"
        )
        .get(`%mine:git:${hash}%`);
      if (alreadyStored) continue;

      const ccMatch = subject.match(/^(\w+)(?:\([^)]+\))?:/);
      const ccType = ccMatch?.[1] ?? "";
      const entryType = conventionalTypeToEntryType(ccType);
      const title = ccMatch
        ? subject.slice(subject.indexOf(":") + 1).trim()
        : subject;

      const content = [
        `mine:git:${hash}`,
        `Author: ${author}`,
        body ? `\n${body}` : "",
      ].join("\n").trim();

      await addManualEntry(db, {
        type: entryType,
        title: title || subject,
        content,
        tags: ["mined:git", `cc:${ccType || "none"}`],
      });
      count++;
    }

    if (!opts.commitHash) {
      const head = (await git.revparse(["HEAD"])).trim();
      if (head) setMiningCursor(db, "last_commit_hash", head);
    }
  } catch (err) {
    logger.warn("mineGitPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/cli/mine.test.ts
```
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mine.ts tests/cli/mine.test.ts
git commit -m "feat(mine): phase 1 — git commit message mining"
```

---

### Task 4: Implement Phase 2 — code comment mining

**Files:**
- Modify: `src/cli/commands/mine.ts`
- Modify: `tests/cli/mine.test.ts`

Phase 2 uses `spawnSync('grep', [...args])` — array args, no shell, no injection risk.

- [ ] **Step 1: Add comment phase tests**

Append to `tests/cli/mine.test.ts`:

```typescript
import { mineCommentsPhase } from "../../src/cli/commands/mine.js";
import { writeFileSync, mkdirSync } from "node:fs";

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/mine.test.ts --testNamePattern "mineCommentsPhase"
```
Expected: FAIL — `mineCommentsPhase` not exported.

- [ ] **Step 3: Add comment phase to `src/cli/commands/mine.ts`**

Add after `mineGitPhase`:

```typescript
// ---------------------------------------------------------------------------
// Phase 2: code comment mining
// ---------------------------------------------------------------------------

// Passed as an array to spawnSync — no shell interpolation, no injection risk.
const GREP_PATTERN = "TODO|FIXME|NOTE|HACK|// Why:|# Why:";
const GREP_EXCLUDE_DIRS = ["node_modules", "dist", "gyst-wiki", ".git"];

function commentToEntryType(
  line: string
): "convention" | "learning" | "error_pattern" {
  const upper = line.toUpperCase();
  if (upper.includes("FIXME") || upper.includes("HACK")) return "error_pattern";
  if (upper.includes("TODO")) return "convention";
  return "learning";
}

export async function mineCommentsPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash">
): Promise<number> {
  let count = 0;
  try {
    const srcDir = join(opts.repoRoot, "src");
    if (!existsSync(srcDir)) return 0;

    const excludeArgs = GREP_EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]);
    // spawnSync with array args — shell never invoked, srcDir not interpolated
    const result = spawnSync(
      "grep",
      ["-rn", "--include=*.ts", "--include=*.js", ...excludeArgs, "-E", GREP_PATTERN, srcDir],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    const raw = (result.stdout ?? "").trim();
    if (!raw) return 0;

    for (const line of raw.split("\n").filter(Boolean)) {
      // Format: /abs/path/file.ts:42:  // TODO: ...
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const afterPath = line.slice(colonIdx + 1);
      const secondColon = afterPath.indexOf(":");
      if (secondColon === -1) continue;
      const filePath = line.slice(0, colonIdx);
      const commentText = afterPath.slice(secondColon + 1).trim();
      if (!commentText) continue;

      const hash = contentHash(commentText);
      const alreadyStored = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM entries WHERE content LIKE ? LIMIT 1"
        )
        .get(`%mine:comment:${hash}%`);
      if (alreadyStored) continue;

      const entryType = commentToEntryType(commentText);
      const relPath = relative(opts.repoRoot, filePath);
      const title = commentText
        .replace(/^(TODO|FIXME|NOTE|HACK|\/\/\s*Why:|#\s*Why:)\s*/i, "")
        .slice(0, 80)
        .trim() || commentText.slice(0, 80);

      await addManualEntry(db, {
        type: entryType,
        title,
        content: `mine:comment:${hash}\nFile: ${relPath}\n\n${commentText}`,
        files: [relPath],
        tags: ["mined:comment"],
      });
      count++;
    }

    setMiningCursor(db, "last_comment_scan", new Date().toISOString());
  } catch (err) {
    logger.warn("mineCommentsPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/cli/mine.test.ts --testNamePattern "mineCommentsPhase"
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mine.ts tests/cli/mine.test.ts
git commit -m "feat(mine): phase 2 — code comment mining (spawnSync, no shell injection)"
```

---

### Task 5: Implement Phase 3 — hot path mining

**Files:**
- Modify: `src/cli/commands/mine.ts`
- Modify: `tests/cli/mine.test.ts`

- [ ] **Step 1: Add hotpath tests**

Append to `tests/cli/mine.test.ts`:

```typescript
import { parseHotPaths } from "../../src/cli/commands/mine.js";

describe("parseHotPaths", () => {
  it("parses git log --name-only output into sorted file counts", () => {
    const raw = [
      "src/store/database.ts",
      "src/store/database.ts",
      "src/cli/index.ts",
      "src/store/database.ts",
      "src/cli/index.ts",
      "src/utils/logger.ts",
    ].join("\n");
    const result = parseHotPaths(raw, 3);
    expect(result[0]?.file).toBe("src/store/database.ts");
    expect(result[0]?.count).toBe(3);
    expect(result[1]?.file).toBe("src/cli/index.ts");
    expect(result[1]?.count).toBe(2);
    expect(result).toHaveLength(3);
  });

  it("filters empty lines", () => {
    const raw = "\n\n\nsrc/foo.ts\n\nsrc/foo.ts\n\n";
    const result = parseHotPaths(raw, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.file).toBe("src/foo.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/mine.test.ts --testNamePattern "parseHotPaths"
```
Expected: FAIL — `parseHotPaths` not exported.

- [ ] **Step 3: Add hotpath phase to `src/cli/commands/mine.ts`**

Add after `mineCommentsPhase`:

```typescript
// ---------------------------------------------------------------------------
// Phase 3: hot path mining
// ---------------------------------------------------------------------------

export interface HotPathEntry {
  readonly file: string;
  readonly count: number;
}

export function parseHotPaths(raw: string, limit: number): HotPathEntry[] {
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("|") || trimmed.startsWith("commit ")) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}

const HOTPATH_LIMIT = 20;
const HOTPATH_CONFIDENCE = 0.9;

export async function mineHotPathsPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash">
): Promise<number> {
  let count = 0;
  try {
    const { default: simpleGit } = await import("simple-git");
    const git = simpleGit(opts.repoRoot);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) return 0;

    const raw = await git.raw(["log", "--format=", "--name-only"]);
    const hotFiles = parseHotPaths(raw, HOTPATH_LIMIT);

    for (const { file, count: editCount } of hotFiles) {
      const absPath = join(opts.repoRoot, file);
      if (!existsSync(absPath)) continue;

      const alreadyCovered = db
        .query<{ id: string }, [string]>(
          `SELECT e.id FROM entries e
           JOIN entry_files ef ON ef.entry_id = e.id
           WHERE e.type = 'ghost_knowledge' AND ef.file_path = ? LIMIT 1`
        )
        .get(file);
      if (alreadyCovered) continue;

      const title = `Hot path: ${file} (${editCount} edits)`;
      const content = [
        `mine:hotpath:${file}`,
        `Edit frequency: ${editCount} commits`,
        ``,
        `This is one of the most frequently modified files in the codebase.`,
        `File: ${file}`,
      ].join("\n");

      // ghost_knowledge is not a valid ManualInput type so write directly
      const id = contentHash(`hotpath:${file}`);
      const now = new Date().toISOString();
      db.run(
        `INSERT OR IGNORE INTO entries
         (id, type, title, content, confidence, scope, status, created_at, updated_at)
         VALUES (?, 'ghost_knowledge', ?, ?, ?, 'project', 'active', ?, ?)`,
        [id, title, content, HOTPATH_CONFIDENCE, now, now]
      );
      db.run("INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)", [id, file]);
      db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)", [id, "mined:hotpath"]);
      count++;
    }

    setMiningCursor(db, "last_hotpath_scan", new Date().toISOString());
  } catch (err) {
    logger.warn("mineHotPathsPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/cli/mine.test.ts --testNamePattern "parseHotPaths"
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mine.ts tests/cli/mine.test.ts
git commit -m "feat(mine): phase 3 — hot path ghost knowledge"
```

---

### Task 6: Implement Phase 4 — selective test describe() mining

**Files:**
- Modify: `src/cli/commands/mine.ts`
- Modify: `tests/cli/mine.test.ts`

- [ ] **Step 1: Add test-phase unit tests**

Append to `tests/cli/mine.test.ts`:

```typescript
import { extractDescribeNames, isBusinessDomainDescribe } from "../../src/cli/commands/mine.js";

describe("extractDescribeNames", () => {
  it("extracts only top-level describe() strings", () => {
    const src = [
      `describe("User authentication handles expired tokens correctly", () => {`,
      `  it("should work", () => {});`,
      `  describe("nested inner suite", () => {});`,
      `});`,
      `describe("Payment processing retries on network failure", () => {});`,
    ].join("\n");
    const result = extractDescribeNames(src);
    expect(result).toContain("User authentication handles expired tokens correctly");
    expect(result).toContain("Payment processing retries on network failure");
    expect(result).not.toContain("nested inner suite");
  });
});

describe("isBusinessDomainDescribe", () => {
  it("accepts long business-domain names", () => {
    expect(isBusinessDomainDescribe("User login flow handles session expiry gracefully")).toBe(true);
    expect(isBusinessDomainDescribe("Knowledge base recall returns ranked results")).toBe(true);
  });

  it("rejects short names (fewer than 5 words)", () => {
    expect(isBusinessDomainDescribe("login flow")).toBe(false);
    expect(isBusinessDomainDescribe("user auth")).toBe(false);
  });

  it("rejects implementation-detail language", () => {
    expect(isBusinessDomainDescribe("getUser returns the correct user object")).toBe(false);
    expect(isBusinessDomainDescribe("should be equal to the expected value")).toBe(false);
    expect(isBusinessDomainDescribe("called with the right arguments")).toBe(false);
    expect(isBusinessDomainDescribe("throws when input is null")).toBe(false);
    expect(isBusinessDomainDescribe("equals the snapshot fixture value")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/mine.test.ts --testNamePattern "extractDescribeNames|isBusinessDomainDescribe"
```
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add test phase to `src/cli/commands/mine.ts`**

Add after `mineHotPathsPhase`:

```typescript
// ---------------------------------------------------------------------------
// Phase 4: integration/e2e test describe() mining
// ---------------------------------------------------------------------------

const IMPL_DETAIL_RE =
  /\b(returns?|equals?|is true|should be|called with|throws?|instanceof)\b/i;
const MIN_DESCRIBE_WORDS = 5;

export function extractDescribeNames(source: string): string[] {
  const results: string[] = [];
  // Only match describe() at column 0 (top-level, no leading whitespace)
  const re = /^describe\s*\(\s*(['"`])([\s\S]*?)\1/gm;
  for (const match of source.matchAll(re)) {
    const name = match[2]?.trim();
    if (name) results.push(name);
  }
  return results;
}

export function isBusinessDomainDescribe(name: string): boolean {
  if (name.trim().split(/\s+/).length < MIN_DESCRIBE_WORDS) return false;
  if (IMPL_DETAIL_RE.test(name)) return false;
  return true;
}

const TEST_GLOB_PATTERNS = [
  "**/*.integration.test.ts",
  "**/*.integration.test.js",
  "**/*.e2e.test.ts",
  "**/*.e2e.test.js",
  "**/*.spec.ts",
  "**/*.spec.js",
];
const TEST_EXCLUDE_RE = /node_modules|dist|gyst-wiki/;

export async function mineTestsPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash">
): Promise<number> {
  let count = 0;
  try {
    const seenHashes = new Set<string>();

    for (const pattern of TEST_GLOB_PATTERNS) {
      const glob = new Glob(pattern);
      for await (const filePath of glob.scan({ cwd: opts.repoRoot, absolute: true })) {
        if (TEST_EXCLUDE_RE.test(filePath)) continue;
        let source: string;
        try {
          source = readFileSync(filePath, "utf8");
        } catch {
          continue;
        }

        const names = extractDescribeNames(source).filter(isBusinessDomainDescribe);
        for (const name of names) {
          const hash = contentHash(name);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);

          const alreadyStored = db
            .query<{ id: string }, [string]>(
              "SELECT id FROM entries WHERE content LIKE ? LIMIT 1"
            )
            .get(`%mine:test:${hash}%`);
          if (alreadyStored) continue;

          const relPath = relative(opts.repoRoot, filePath);
          await addManualEntry(db, {
            type: "convention",
            title: name,
            content: `mine:test:${hash}\nSource: ${relPath}\n\nExpected system behaviour: ${name}`,
            files: [relPath],
            tags: ["mined:test"],
          });
          count++;
        }
      }
    }

    setMiningCursor(db, "last_test_scan", new Date().toISOString());
  } catch (err) {
    logger.warn("mineTestsPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}
```

- [ ] **Step 4: Run all mine tests**

```bash
bun test tests/cli/mine.test.ts
```
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mine.ts tests/cli/mine.test.ts
git commit -m "feat(mine): phase 4 — selective test describe() mining"
```

---

### Task 7: `runMine()` orchestrator + CLI command registration

**Files:**
- Modify: `src/cli/commands/mine.ts` (add `runMine()`)
- Modify: `src/cli/index.ts` (add `gyst mine` command)

- [ ] **Step 1: Add `runMine()` to end of `src/cli/commands/mine.ts`**

```typescript
// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runMine(opts: MineOptions): Promise<MineResult> {
  const config = loadConfig(opts.repoRoot);
  const db = await initDatabase(config.dbPath);
  try {
    const git = await mineGitPhase(db, opts);
    const comments = await mineCommentsPhase(db, opts);
    const hotpaths = await mineHotPathsPhase(db, opts);
    const tests = await mineTestsPhase(db, opts);
    logger.info("runMine: complete", { git, comments, hotpaths, tests });
    return { git, comments, hotpaths, tests };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Register `gyst mine` in `src/cli/index.ts`**

Add this import near the top where other command imports live (line ~44 where `self-document` is imported):

```typescript
import { runMine } from "./commands/mine.js";
```

Find the `program.command("self-document")` block (around line 836). Add the `mine` command **before** it:

```typescript
program
  .command("mine")
  .description("Mine codebase for institutional knowledge (git history, comments, hot paths, tests)")
  .option("--commit <hash>", "Mine only this specific commit (post-commit hook path)")
  .option("--full", "Full scan ignoring incremental cursor", false)
  .option("--no-llm", "Skip LLM summarisation", false)
  .action(async (opts) => {
    const { default: simpleGit } = await import("simple-git");
    const git = simpleGit();
    let repoRoot: string;
    try {
      repoRoot = (await git.revparse(["--show-toplevel"])).trim();
    } catch {
      repoRoot = process.cwd();
    }
    const result = await runMine({
      commitHash: typeof opts.commit === "string" ? opts.commit : undefined,
      full: opts.full === true,
      noLlm: opts.noLlm !== false,
      repoRoot,
    });
    process.stdout.write(
      `gyst mine: +${result.git} git, +${result.comments} comments, ` +
        `+${result.hotpaths} hotpaths, +${result.tests} tests\n`
    );
  });
```

- [ ] **Step 3: Run lint**

```bash
bun run lint
```
Expected: 0 errors.

- [ ] **Step 4: Run full test suite**

```bash
bun test
```
Expected: All existing tests still pass.

- [ ] **Step 5: Smoke-test the CLI command**

```bash
bun run src/cli/index.ts mine --full --no-llm 2>/dev/null | head -3
```
Expected output like: `gyst mine: +N git, +N comments, +N hotpaths, +N tests`

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/mine.ts src/cli/index.ts
git commit -m "feat(mine): runMine orchestrator + CLI command registration"
```

---

### Task 8: Wire mine into plugin hook scripts

**Files:**
- Modify: `plugin/scripts/session-start.js`
- Modify: `plugin/scripts/session-end.js`
- Modify: `plugin/scripts/pre-compact.js`

- [ ] **Step 1: Add mine spawn to `plugin/scripts/session-start.js`**

Find the `selfDoc.unref();` line (inside the try block). Add immediately after it:

```js
  try {
    const mine = spawn(gyst, ["mine", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    mine.unref();
  } catch {
    // non-fatal
  }
```

- [ ] **Step 2: Add mine spawn to `plugin/scripts/session-end.js`**

Find the `selfDoc.unref();` line. Add immediately after it:

```js
  try {
    const mine = spawn(gyst, ["mine", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    mine.unref();
  } catch {
    // non-fatal
  }
```

- [ ] **Step 3: Add mine spawn to `plugin/scripts/pre-compact.js`**

Add `import { spawn } from "node:child_process";` at the top (first line after the shebang).

Inside the `try` block, before `process.stdout.write(...)`, add (using the existing `gyst` variable — define it first since pre-compact doesn't have it yet):

```js
  const gyst = process.env.GYST_BIN || "gyst";
  try {
    const mine = spawn(gyst, ["mine", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    mine.unref();
  } catch {
    // non-fatal
  }
```

- [ ] **Step 4: Verify scripts parse without errors**

```bash
node --check plugin/scripts/session-start.js && \
node --check plugin/scripts/session-end.js && \
node --check plugin/scripts/pre-compact.js && \
echo "all OK"
```
Expected: `all OK`

- [ ] **Step 5: Commit**

```bash
git add plugin/scripts/session-start.js plugin/scripts/session-end.js plugin/scripts/pre-compact.js
git commit -m "feat(mine): wire mine --no-llm into SessionStart, Stop, PreCompact hooks"
```

---

### Task 9: Wire mine into git post-commit hook

**Files:**
- Modify: `src/capture/git-hook.ts`

- [ ] **Step 1: Replace the `if (import.meta.main)` block in `src/capture/git-hook.ts`**

Find the block starting at line 183:
```typescript
if (import.meta.main) {
  captureCommit().catch((err: unknown) => {
```

Replace the entire block with:

```typescript
if (import.meta.main) {
  captureCommit()
    .then(async () => {
      // Fire-and-forget mine of the just-landed commit.
      // Never blocks the commit — unref() detaches the child immediately.
      const gyst = process.env["GYST_BIN"] ?? "gyst";
      const { spawn } = await import("node:child_process");
      const mine = spawn(gyst, ["mine", "--commit", "HEAD", "--no-llm"], {
        detached: true,
        stdio: "ignore",
      });
      mine.unref();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to capture commit", { error: message });
      // Never block the commit — always exit 0
      process.exit(0);
    });
}
```

- [ ] **Step 2: Run lint**

```bash
bun run lint
```
Expected: 0 errors.

- [ ] **Step 3: Run all tests**

```bash
bun test
```
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/capture/git-hook.ts
git commit -m "feat(mine): fire mine --commit HEAD from git post-commit hook"
```

---

### Task 10: README + WORKFLOW.md docs updates

**Files:**
- Modify: `README.md`
- Modify: `plugin/WORKFLOW.md`

- [ ] **Step 1: Add "Automated Context Construction" section to README**

Find the `## Self-Documenting KB` section. Add a new `## Automated Context Construction` section **after** it:

```markdown
## Automated Context Construction

Gyst mines four signal sources automatically — no manual entries required:

| Source | What it captures | Entry type |
|--------|-----------------|------------|
| Git commit messages | Why things were built or changed | `decision`, `learning` |
| Code comments (`TODO`/`FIXME`/`NOTE`/`HACK`/`// Why:`) | Design intent, known issues | `convention`, `error_pattern` |
| Hot-path files (top-20 most-edited) | Core architecture modules | `ghost_knowledge` |
| Integration/E2E `describe()` names | Expected system behaviour in business language | `convention` |

```bash
gyst mine                    # incremental run (all four phases)
gyst mine --full             # full scan from the beginning
gyst mine --commit HEAD      # mine a single commit (post-commit hook path)
gyst mine --no-llm           # skip Haiku summarisation (default when no API key)
```

Mining runs automatically at every trigger point:

```
commit made     → post-commit hook → gyst mine --commit HEAD
session opens   → SessionStart     → gyst self-document + gyst mine
session ends    → Stop             → harvest-session + gyst mine
before compact  → PreCompact       → harvest-session + gyst mine
```

Tests are filtered aggressively: only `.integration.test.*`, `.e2e.test.*`, and `.spec.*` files; only top-level `describe()` blocks; only names with 5+ words that contain no implementation-detail language ("returns", "equals", "should be", "throws", etc.).
```

- [ ] **Step 2: Add `gyst mine` to the CLI Commands table in README**

Find the table row for `gyst self-document`. Add a row **after** it:

```markdown
| `gyst mine [--full] [--commit <hash>] [--no-llm]` | Mine git history, comments, hot paths, and tests into the KB |
```

- [ ] **Step 3: Update the Hooks table in README**

Find the three rows for `SessionStart`, `Stop`, `PreCompact`. Update them:

```markdown
| `SessionStart` | Injects team context + ghost knowledge; fires `self-document` + `mine` refresh |
| `Stop` | Triggers session distillation; fires `mine` incremental refresh |
| `PreCompact` | Harvests session before context erased; fires `mine` incremental refresh |
```

- [ ] **Step 4: Add autonomous mining loop to `plugin/WORKFLOW.md`**

Find the hooks section. Add:

```markdown
## Autonomous Mining Loop

`gyst mine` fires at all four trigger points automatically:

| Trigger | Command |
|---------|---------|
| `git commit` → post-commit hook | `gyst mine --commit HEAD --no-llm` |
| Session opens → SessionStart | `gyst mine --no-llm` |
| Session ends → Stop | `gyst mine --no-llm` |
| Before compact → PreCompact | `gyst mine --no-llm` |

All spawns are detached and unref'd — fire-and-forget, zero latency to the agent loop.
```

- [ ] **Step 5: Commit**

```bash
git add README.md plugin/WORKFLOW.md
git commit -m "docs: Automated Context Construction section + mine in CLI + hooks tables"
```

---

### Task 11: Version bump + publish-ready sweep

- [ ] **Step 1: Run full test suite**

```bash
bun test
```
Expected: All pass.

- [ ] **Step 2: Run lint**

```bash
bun run lint
```
Expected: 0 errors.

- [ ] **Step 3: Sweep test-generated wiki artifacts**

```bash
find gyst-wiki -name '*-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].md' -delete 2>/dev/null || true
```

- [ ] **Step 4: Bump version in `package.json`**

Change `"version": "0.1.38"` → `"0.1.39"`.

- [ ] **Step 5: Bump version in `plugin/plugin.json`**

Change `"version": "0.1.38"` → `"0.1.39"`.

- [ ] **Step 6: Build**

```bash
bun run build
```
Expected: Build succeeds.

- [ ] **Step 7: Commit and push**

```bash
git add package.json plugin/plugin.json dist/
git commit -m "feat(mine): automated context construction; bump to 0.1.39"
git push
```

---

## Self-Review

**Spec coverage:**
- [x] `codebase_mining_state` cursor table → Task 1
- [x] Phase 1 git history mining → Task 3
- [x] Phase 2 code comments mining → Task 4
- [x] Phase 3 hot paths → Task 5
- [x] Phase 4 selective tests (5+ words, no impl-detail language) → Task 6
- [x] `gyst mine` CLI command with `--commit`, `--full`, `--no-llm` → Task 7
- [x] SessionStart hook wiring → Task 8
- [x] Stop hook wiring → Task 8
- [x] PreCompact hook wiring → Task 8
- [x] git post-commit hook wiring → Task 9
- [x] README "Automated Context Construction" section → Task 10
- [x] WORKFLOW.md autonomous loop → Task 10
- [x] Version bump + publish-ready sweep → Task 11

**No placeholders found.**

**Security:** grep uses `spawnSync` with array args (no shell). git operations use simple-git's array API. No user input interpolated into shell strings.

**Type consistency:** `MineOptions`, `MineResult`, `HotPathEntry` defined in Task 2, referenced identically in all subsequent tasks.
