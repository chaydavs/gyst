# Database-First Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse the data flow so SQLite is the sole source of truth — markdown files become a one-way export, consolidation deletes stale markdown, and rebuild never overwrites existing DB entries.

**Architecture:** `learn` writes to DB first; markdown is only written when `autoExport: true` in config. A new `markdown_path` column on `entries` tracks whether a file exists on disk. Consolidation reads `markdown_path` and deletes the file when an entry is archived or consolidated. `rebuild` switches to `INSERT OR IGNORE` so it can safely migrate legacy installs without clobbering live data. A new `gyst export` command re-derives all markdown from DB on demand.

**Tech Stack:** Bun, TypeScript strict mode, `bun:sqlite`, `node:fs` (unlinkSync), `commander`, `bun test`

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/utils/config.ts` | Add `autoExport` boolean to ConfigSchema |
| Modify | `src/store/database.ts` | Add `markdown_path TEXT` column + migration |
| Modify | `src/mcp/tools/learn.ts` | Gate `writeEntry` behind `autoExport`; store returned path in `markdown_path` |
| Modify | `src/compiler/consolidate.ts` | Delete markdown file in stage2/stage3/stage4 when path is set |
| Modify | `src/store/rebuild.ts` | Switch `upsertEntry` to `INSERT OR IGNORE` (skip existing DB entries) |
| Create | `src/cli/export.ts` | `exportToMarkdown(db, config)` — DB → markdown for all active entries |
| Modify | `src/cli/index.ts` | Register `gyst export` command |
| Modify | `tests/store/rebuild.test.ts` | Assert existing DB entries are NOT overwritten |
| Modify | `tests/compiler/consolidate.test.ts` | Assert markdown files are deleted on archive/consolidation |
| Create | `tests/cli/export.test.ts` | Assert `exportToMarkdown` writes correct files and updates `markdown_path` |

---

## Task 1: Add `autoExport` to Config

**Files:**
- Modify: `src/utils/config.ts`
- Test: none needed (schema validation is covered by the existing config tests; add one assertion)

- [ ] **Step 1: Write the failing test**

Open `tests/cli/install.test.ts` (or any test that calls `loadConfig`) and add at the bottom:

```typescript
test("loadConfig: autoExport defaults to false", () => {
  const cfg = loadConfig();
  expect(cfg.autoExport).toBe(false);
});

test("loadConfig: autoExport can be set to true", () => {
  const tmpDir = fs.mkdtempSync(join(tmpdir(), "gyst-cfg-"));
  fs.writeFileSync(
    join(tmpDir, ".gyst-wiki.json"),
    JSON.stringify({ autoExport: true }),
  );
  const cfg = loadConfig(tmpDir);
  expect(cfg.autoExport).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/chaitanyadavuluri/Desktop/SustainableMemory
bun test tests/cli/install.test.ts 2>&1 | tail -20
```

Expected: `TypeError: cfg.autoExport is undefined` or property missing.

- [ ] **Step 3: Add `autoExport` to ConfigSchema**

In `src/utils/config.ts`, find the `ConfigSchema = z.object({` block (line ~19) and add after `logLevel`:

```typescript
  /** When true, write markdown files after every learn and export. Default: false. */
  autoExport: z.boolean().default(false),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/cli/install.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts tests/cli/install.test.ts
git commit -m "feat: add autoExport config option (default false)"
```

---

## Task 2: Add `markdown_path` Column to Schema

**Files:**
- Modify: `src/store/database.ts`
- Test: `tests/store/database.test.ts` (add assertion)

The `entries` table needs a nullable `markdown_path TEXT` column. Because `initDatabase` runs DDL idempotently via `CREATE TABLE IF NOT EXISTS`, we add this as an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migration that runs after table creation.

- [ ] **Step 1: Write the failing test**

Find `tests/store/` and open the database test file (likely `tests/store/database.test.ts`). Add:

```typescript
test("entries table has markdown_path column", () => {
  const db = initDatabase(":memory:");
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(entries)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("markdown_path");
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test tests/store/database.test.ts 2>&1 | tail -15
```

Expected: `Expected array to contain 'markdown_path'`.

- [ ] **Step 3: Add the column and migration**

In `src/store/database.ts`, find the `SCHEMA_STATEMENTS` array (the array of DDL strings). After the `entries` `CREATE TABLE IF NOT EXISTS` statement (around line 126), add:

```typescript
// Migration: add markdown_path column (safe to run on existing DBs)
`ALTER TABLE entries ADD COLUMN markdown_path TEXT`,
```

Then locate the `initDatabase` function body. Find the loop that runs schema statements. Wrap the new `ALTER TABLE` with a try/catch that silently ignores `duplicate column name` errors — SQLite throws if you try to add an existing column:

```typescript
for (const stmt of SCHEMA_STATEMENTS) {
  try {
    db.run(stmt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ALTER TABLE ADD COLUMN fails if column already exists — safe to ignore
    if (msg.includes("duplicate column name")) continue;
    throw new DatabaseError(`Schema migration failed: ${msg}`);
  }
}
```

> If `initDatabase` already wraps DDL in a loop, find that loop and apply the `duplicate column name` ignore. If it runs statements directly (no loop), wrap the `ALTER TABLE` call specifically.

- [ ] **Step 4: Verify test passes**

```bash
bun test tests/store/database.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Verify full suite still green**

```bash
bun test tests/store/ 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src/store/database.ts tests/store/database.test.ts
git commit -m "feat: add markdown_path column to entries table"
```

---

## Task 3: Gate `writeEntry` Behind `autoExport` in learn.ts

**Files:**
- Modify: `src/mcp/tools/learn.ts`
- Test: `tests/mcp/learn.test.ts`

Currently `persistEntry()` always calls `writeEntry(...)`. After this task it only calls it when `config.autoExport === true`, and it stores the returned path in `entries.markdown_path`.

- [ ] **Step 1: Write the failing tests**

Open `tests/mcp/learn.test.ts`. Add two tests:

```typescript
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("learn: does NOT write markdown when autoExport is false (default)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gyst-learn-"));
  const wikiDir = join(tmpDir, "gyst-wiki");
  const db = initDatabase(join(tmpDir, ".wiki.db"));

  // Call persistEntry via the learn tool with autoExport not set
  // Use the MCP handler directly
  const result = await callLearnTool(db, {
    type: "learning",
    title: "No markdown test",
    content: "Should not create a markdown file",
  }, { wikiDir, autoExport: false });

  expect(result.isError).toBe(false);
  // No markdown files should exist
  const mdFiles = existsSync(wikiDir)
    ? readdirSync(wikiDir, { recursive: true }).filter((f) =>
        String(f).endsWith(".md"),
      )
    : [];
  expect(mdFiles).toHaveLength(0);

  // But DB should have the entry
  const row = db.query("SELECT id FROM entries WHERE title = ?").get("No markdown test");
  expect(row).not.toBeNull();

  rmSync(tmpDir, { recursive: true });
  db.close();
});

test("learn: writes markdown AND sets markdown_path when autoExport is true", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gyst-learn-export-"));
  const wikiDir = join(tmpDir, "gyst-wiki");
  const db = initDatabase(join(tmpDir, ".wiki.db"));

  const result = await callLearnTool(db, {
    type: "learning",
    title: "Export test",
    content: "Should create a markdown file",
  }, { wikiDir, autoExport: true });

  expect(result.isError).toBe(false);

  // Markdown file must exist
  const mdFiles = readdirSync(wikiDir, { recursive: true }).filter((f) =>
    String(f).endsWith(".md"),
  );
  expect(mdFiles.length).toBeGreaterThan(0);

  // DB row must have markdown_path set
  const row = db
    .query<{ markdown_path: string | null }, []>(
      "SELECT markdown_path FROM entries WHERE title = 'Export test'",
    )
    .get();
  expect(row?.markdown_path).not.toBeNull();

  rmSync(tmpDir, { recursive: true });
  db.close();
});
```

> Note: `callLearnTool` is a test helper. Look at how the existing `learn.test.ts` invokes the tool — adapt to match that pattern. The key is passing a config override with `{ wikiDir, autoExport: false/true }`.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/mcp/learn.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|PASS|Error" | tail -20
```

- [ ] **Step 3: Modify `persistEntry` in learn.ts**

`persistEntry` is at line ~72. Find the `writeEntry(...)` call (around line 142). Replace the unconditional call with:

```typescript
// Load config to check autoExport — learn.ts already calls loadConfig() for wikiDir
const config = loadConfig();
let markdownPath: string | null = null;
if (config.autoExport) {
  markdownPath = writeEntry(
    {
      id: entry.id,
      type: entry.type as "error_pattern" | "convention" | "decision" | "learning",
      title: entry.title,
      content: entry.content,
      files: entry.files,
      tags: entry.tags,
      errorSignature: entry.errorSignature,
      confidence: entry.confidence,
      sourceCount: entry.sourceCount ?? 1,
      sourceTool: entry.sourceTool,
      createdAt: entry.createdAt,
      scope: entry.scope,
    },
    config.wikiDir,
  );
}
```

Then, still inside the same transaction in `persistEntry`, after the `db.run("INSERT INTO entries ...")` call, add:

```typescript
if (markdownPath !== null) {
  db.run(
    "UPDATE entries SET markdown_path = ? WHERE id = ?",
    [markdownPath, entry.id],
  );
}
```

> `persistEntry` wraps its work in a `withRetry(() => { db.transaction(...)() })` block. Place the `UPDATE` inside the same transaction closure, after the INSERT.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/mcp/learn.test.ts 2>&1 | tail -15
```

- [ ] **Step 5: Verify no regression across all mcp tests**

```bash
bun test tests/mcp/ 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/learn.ts tests/mcp/learn.test.ts
git commit -m "feat: gate writeEntry behind autoExport; store markdown_path in DB"
```

---

## Task 4: Delete Markdown Files on Archive / Consolidate

**Files:**
- Modify: `src/compiler/consolidate.ts`
- Test: `tests/compiler/consolidate.test.ts`

Three stages change entry status to non-active: stage2 (`'consolidated'`), stage3 (`'consolidated'`), stage4 (`'archived'`). Each must read `markdown_path` from the entry before changing status, then `unlinkSync` that path if it is non-null and the file exists.

- [ ] **Step 1: Write the failing tests**

Open `tests/compiler/consolidate.test.ts`. Add a `describe` block:

```typescript
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("consolidate: markdown file deletion", () => {
  test("stage4Archive deletes markdown file for archived entry", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gyst-con-"));
    const wikiDir = join(tmpDir, "gyst-wiki", "learning");
    mkdirSync(wikiDir, { recursive: true });

    const db = initDatabase(join(tmpDir, ".wiki.db"));
    const mdFile = join(wikiDir, "stale-entry-abc12345.md");
    writeFileSync(mdFile, "# stale entry\n", "utf8");

    // Insert a low-confidence entry with markdown_path set
    db.run(
      `INSERT INTO entries
         (id, type, title, content, file_path, confidence, source_count,
          source_tool, created_at, last_confirmed, status, scope, markdown_path)
       VALUES (?, 'learning', 'Stale entry', 'body', null, 0.05, 1,
               'test', datetime('now'), datetime('now'), 'active', 'team', ?)`,
      ["stale-entry-abc12345", mdFile],
    );
    db.run(
      "INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')",
    );

    await consolidate(db, { wikiDir: join(tmpDir, "gyst-wiki") });

    // File must be deleted
    expect(existsSync(mdFile)).toBe(false);

    // Entry must be archived in DB
    const row = db
      .query<{ status: string }, []>(
        "SELECT status FROM entries WHERE id = 'stale-entry-abc12345'",
      )
      .get();
    expect(row?.status).toBe("archived");

    rmSync(tmpDir, { recursive: true });
    db.close();
  });

  test("stage4Archive is safe when markdown_path is null", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gyst-con-null-"));
    const db = initDatabase(join(tmpDir, ".wiki.db"));

    db.run(
      `INSERT INTO entries
         (id, type, title, content, file_path, confidence, source_count,
          source_tool, created_at, last_confirmed, status, scope)
       VALUES ('no-md-abc12345', 'learning', 'No markdown', 'body',
               null, 0.05, 1, 'test', datetime('now'), datetime('now'), 'active', 'team')`,
    );

    // Should not throw even though there's no file
    await expect(
      consolidate(db, { wikiDir: join(tmpDir, "gyst-wiki") }),
    ).resolves.not.toThrow();

    rmSync(tmpDir, { recursive: true });
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/compiler/consolidate.test.ts -t "markdown file deletion" 2>&1 | tail -15
```

Expected: first test fails because the markdown file still exists after consolidation.

- [ ] **Step 3: Add a `deleteMarkdownFile` helper at the top of consolidate.ts**

After the imports, add:

```typescript
import { unlinkSync, existsSync } from "node:fs";

/**
 * Deletes the on-disk markdown file for an entry if one exists.
 * Safe to call when markdown_path is null or the file is already gone.
 */
function deleteMarkdownFile(markdownPath: string | null): void {
  if (!markdownPath) return;
  try {
    if (existsSync(markdownPath)) {
      unlinkSync(markdownPath);
      logger.debug("Deleted markdown file", { path: markdownPath });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to delete markdown file", { path: markdownPath, error: msg });
  }
}
```

- [ ] **Step 4: Add `markdown_path` to the `ActiveEntryRow` interface**

Find `interface ActiveEntryRow` (around line 47) and add the field:

```typescript
interface ActiveEntryRow {
  id: string;
  type: string;
  title: string;
  confidence: number;
  markdown_path: string | null;  // ← add this
}
```

- [ ] **Step 5: Update `stage4Archive` to delete files before the bulk UPDATE**

Find `stage4Archive` (line ~492). Replace the body with:

```typescript
function stage4Archive(db: Database): number {
  logger.info("consolidate: stage 4 — archive");

  try {
    // Collect paths before changing status
    const toArchive = db
      .query<{ id: string; markdown_path: string | null }, []>(
        `SELECT id, markdown_path FROM entries
         WHERE status = 'active' AND confidence < 0.15 AND type != 'ghost_knowledge'`,
      )
      .all();

    if (toArchive.length === 0) return 0;

    for (const row of toArchive) {
      deleteMarkdownFile(row.markdown_path);
    }

    const result = db.run(
      `UPDATE entries
       SET status = 'archived', markdown_path = null
       WHERE status = 'active'
         AND confidence < 0.15
         AND type != 'ghost_knowledge'`,
    );

    const count = result.changes ?? 0;
    logger.info("consolidate: stage 4 complete", { archived: count });
    return count;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`stage4Archive failed: ${msg}`);
  }
}
```

- [ ] **Step 6: Update `stage2Dedupe` to delete files when marking `'consolidated'`**

In `stage2Dedupe`, every place that runs:
```typescript
"UPDATE entries SET status = 'consolidated', superseded_by = ? WHERE id = ?"
```
precede it with a fetch of `markdown_path` and a call to `deleteMarkdownFile`. The pattern is:

```typescript
// Before the UPDATE:
const mdRow = db
  .query<{ markdown_path: string | null }, [string]>(
    "SELECT markdown_path FROM entries WHERE id = ?",
  )
  .get(archiveId); // use the id of the entry being consolidated
deleteMarkdownFile(mdRow?.markdown_path ?? null);

// The existing UPDATE, extended to also null out markdown_path:
db.run(
  "UPDATE entries SET status = 'consolidated', superseded_by = ?, markdown_path = null WHERE id = ?",
  [keepId, archiveId],
);
```

There are two UPDATE calls matching this pattern in stage2 (fingerprint dedupe ~line 213, semantic dedupe ~line 334). Apply the same fetch-then-delete pattern to both. Use the correct variable name for the id being archived at each call site.

- [ ] **Step 7: Update `stage3MergeClusters` similarly**

In `stage3MergeClusters`, find the UPDATE `SET status = 'consolidated'` (around line 464) and apply the same fetch-then-delete pattern before it, and add `markdown_path = null` to the UPDATE.

- [ ] **Step 8: Run the new tests**

```bash
bun test tests/compiler/consolidate.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 9: Run the full consolidate suite**

```bash
bun test tests/compiler/ 2>&1 | tail -10
```

- [ ] **Step 10: Commit**

```bash
git add src/compiler/consolidate.ts tests/compiler/consolidate.test.ts
git commit -m "feat: delete markdown files when entries are archived or consolidated"
```

---

## Task 5: Make Rebuild Preserve Existing DB Entries

**Files:**
- Modify: `src/store/rebuild.ts`
- Test: `tests/store/rebuild.test.ts`

Currently `upsertEntry` uses `ON CONFLICT(id) DO UPDATE SET …` — it overwrites every field of an existing entry. The Database-First rule says rebuild should only INSERT new entries (from legacy markdown), never overwrite entries already in DB. Change to `INSERT OR IGNORE`.

- [ ] **Step 1: Write the failing test**

Open `tests/store/rebuild.test.ts`. Add:

```typescript
test("rebuild does not overwrite an existing DB entry", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gyst-rebuild-"));
  const wikiDir = join(tmpDir, "gyst-wiki", "learning");
  mkdirSync(wikiDir, { recursive: true });
  const db = initDatabase(join(tmpDir, ".wiki.db"));

  // Write a markdown file
  const mdContent = `---
id: test-preserve-01
type: learning
title: Original from markdown
confidence: 0.7
created_at: "2025-01-01T00:00:00.000Z"
last_confirmed: "2025-01-01T00:00:00.000Z"
tags: []
files: []
---
# Original from markdown
Body text.
`;
  writeFileSync(join(wikiDir, "original-test-preserve-01.md"), mdContent, "utf8");

  // Pre-insert the same ID with a different title (simulates live DB entry)
  db.run(
    `INSERT INTO entries
       (id, type, title, content, file_path, confidence, source_count,
        source_tool, created_at, last_confirmed, status, scope)
     VALUES ('test-preserve-01', 'learning', 'Live DB title', 'live body',
             null, 0.9, 5, 'mcp', datetime('now'), datetime('now'), 'active', 'team')`,
  );

  // Run rebuild
  await rebuildFromMarkdown({ wikiDir: join(tmpDir, "gyst-wiki"), dbPath: join(tmpDir, ".wiki.db") } as Config);

  // DB entry must NOT have been overwritten
  const row = db
    .query<{ title: string; confidence: number }, []>(
      "SELECT title, confidence FROM entries WHERE id = 'test-preserve-01'",
    )
    .get();
  expect(row?.title).toBe("Live DB title");
  expect(row?.confidence).toBe(0.9);

  rmSync(tmpDir, { recursive: true });
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test tests/store/rebuild.test.ts -t "does not overwrite" 2>&1 | tail -15
```

Expected: test fails — `row.title` is `"Original from markdown"` (overwritten).

- [ ] **Step 3: Change `upsertEntry` in rebuild.ts to `INSERT OR IGNORE`**

Find `upsertEntry` (line ~342 in `src/store/rebuild.ts`). Replace the `INSERT … ON CONFLICT DO UPDATE SET …` block with `INSERT OR IGNORE`:

```typescript
db.run(
  `INSERT OR IGNORE INTO entries
     (id, type, title, content, file_path, error_signature,
      confidence, source_count, source_tool, created_at, last_confirmed, status, scope, markdown_path)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    entry.id,
    entry.type,
    entry.title,
    entry.content,
    entry.filePath ?? null,
    entry.errorSignature ?? null,
    entry.confidence,
    entry.sourceCount,
    entry.sourceTool ?? null,
    entry.createdAt,
    entry.lastConfirmed,
    entry.status ?? "active",
    entry.scope ?? "team",
    entry.relPath,   // store the legacy markdown path for reference
  ],
);
```

Also update the `entry_files` and `entry_tags` inserts — they already use `INSERT OR IGNORE` so they're fine.

Update the return value: since we can no longer distinguish created vs updated from a single INSERT OR IGNORE, check existence first (the function already does this at line ~344 with a `SELECT id` check) and return based on that.

- [ ] **Step 4: Run the new test**

```bash
bun test tests/store/rebuild.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Run the full rebuild suite**

```bash
bun test tests/store/ 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src/store/rebuild.ts tests/store/rebuild.test.ts
git commit -m "feat: rebuild uses INSERT OR IGNORE — never overwrites live DB entries"
```

---

## Task 6: `gyst export` Command

**Files:**
- Create: `src/cli/export.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli/export.test.ts`

`gyst export` reads all active entries from DB, calls `writeEntry` for each, and updates `markdown_path` in the DB. It always writes regardless of `autoExport` config — it's an explicit user action.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/export.test.ts`:

```typescript
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
    const config = {
      wikiDir,
      dbPath: join(tmpDir, ".wiki.db"),
      autoExport: false,
    } as unknown as Config;

    // Insert two active entries and one archived entry
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

    // Files must exist for the two active entries
    const mdFiles = readdirSync(wikiDir, { recursive: true })
      .filter((f) => String(f).endsWith(".md") && !String(f).endsWith("index.md"));
    expect(mdFiles).toHaveLength(2);

    db.close();
  });

  test("updates markdown_path in DB after writing", async () => {
    const db = initDatabase(join(tmpDir, ".wiki.db"));
    const config = { wikiDir, dbPath: join(tmpDir, ".wiki.db") } as unknown as Config;

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

  test("skips entries whose markdown file already exists and is up to date", async () => {
    const db = initDatabase(join(tmpDir, ".wiki.db"));
    const config = { wikiDir, dbPath: join(tmpDir, ".wiki.db") } as unknown as Config;

    // Write a markdown file manually and record it
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
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/cli/export.test.ts 2>&1 | tail -15
```

Expected: `Cannot find module '../../src/cli/export.js'`.

- [ ] **Step 3: Create `src/cli/export.ts`**

```typescript
/**
 * gyst export — DB-first markdown exporter.
 *
 * Reads all active entries from the database and writes one markdown file
 * per entry to the wiki directory. Updates entries.markdown_path in the DB.
 *
 * This is the ONLY path for generating markdown files on teams that keep
 * autoExport:false. It is always available as an explicit CLI command regardless
 * of the autoExport setting.
 */

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { writeEntry } from "../compiler/writer.js";
import { logger } from "../utils/logger.js";
import type { Config } from "../utils/config.js";

interface ActiveEntryForExport {
  id: string;
  type: "error_pattern" | "convention" | "decision" | "learning";
  title: string;
  content: string;
  confidence: number;
  source_count: number;
  source_tool: string | null;
  created_at: string;
  last_confirmed: string;
  scope: string;
  markdown_path: string | null;
}

interface ExportResult {
  exported: number;
  skipped: number;
}

/**
 * Exports all active (non-archived, non-consolidated) entries to markdown.
 *
 * Skips entries that already have a markdown_path pointing to an existing file.
 * For each written file, updates entries.markdown_path in the DB.
 *
 * @param db     - Open database connection.
 * @param config - Resolved Gyst config (uses config.wikiDir for output path).
 * @returns      Counts of exported and skipped entries.
 */
export async function exportToMarkdown(
  db: Database,
  config: Pick<Config, "wikiDir">,
): Promise<ExportResult> {
  const rows = db
    .query<ActiveEntryForExport, []>(
      `SELECT id, type, title, content, confidence, source_count, source_tool,
              created_at, last_confirmed, scope, markdown_path
       FROM entries
       WHERE status = 'active'
       ORDER BY created_at ASC`,
    )
    .all();

  let exported = 0;
  let skipped = 0;

  for (const row of rows) {
    // Skip if file already exists on disk
    if (row.markdown_path && existsSync(row.markdown_path)) {
      skipped += 1;
      continue;
    }

    try {
      const tags = db
        .query<{ tag: string }, [string]>(
          "SELECT tag FROM entry_tags WHERE entry_id = ?",
          [row.id],
        )
        .all()
        .map((r) => r.tag);

      const files = db
        .query<{ file_path: string }, [string]>(
          "SELECT file_path FROM entry_files WHERE entry_id = ?",
          [row.id],
        )
        .all()
        .map((r) => r.file_path);

      const mdPath = writeEntry(
        {
          id: row.id,
          type: row.type,
          title: row.title,
          content: row.content,
          files,
          tags,
          confidence: row.confidence,
          sourceCount: row.source_count,
          sourceTool: row.source_tool ?? undefined,
          createdAt: row.created_at,
          scope: row.scope as "team" | "personal" | "project",
        },
        config.wikiDir,
      );

      db.run("UPDATE entries SET markdown_path = ? WHERE id = ?", [
        mdPath,
        row.id,
      ]);
      exported += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("exportToMarkdown: failed to write entry", {
        id: row.id,
        error: msg,
      });
    }
  }

  logger.info("exportToMarkdown complete", { exported, skipped });
  return { exported, skipped };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test tests/cli/export.test.ts 2>&1 | tail -20
```

- [ ] **Step 5: Register `gyst export` in `src/cli/index.ts`**

Add the import near the top of `src/cli/index.ts` (after existing imports):

```typescript
import { exportToMarkdown } from "./export.js";
```

Find where other commands are registered (e.g., around `program.command("setup")`). Add:

```typescript
program
  .command("export")
  .description("Export all active knowledge entries to markdown files (derived from DB)")
  .action(async () => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const result = await exportToMarkdown(db, config);
      process.stdout.write(
        `Exported ${result.exported} entries, skipped ${result.skipped} (already on disk).\n`,
      );
      db.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("export failed", { error: msg });
      process.exit(1);
    }
  });
```

Also register the short alias `gyst show exports` / `gyst exports` if the codebase pattern supports it (check existing aliases in `src/cli/index.ts` — follow the same pattern).

- [ ] **Step 6: Run all CLI tests**

```bash
bun test tests/cli/ 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/export.ts src/cli/index.ts tests/cli/export.test.ts
git commit -m "feat: add gyst export command — derives markdown from DB"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Full test suite**

```bash
bun test tests/store/ tests/mcp/ tests/compiler/ tests/cli/ 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 2: TypeScript check**

```bash
bun run lint 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 3: Update CLAUDE.md architecture note**

In `CLAUDE.md`, find the line:
```
Markdown files are source of truth. SQLite is a derived index
```
Replace with:
```
SQLite is the source of truth. Markdown files are a derived export (autoExport config or gyst export command).
If SQLite is deleted, use `gyst export` after restoring a DB backup, or run `gyst rebuild` to migrate legacy markdown.
```

- [ ] **Step 4: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: update architecture note — DB is now source of truth"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|-------------|------|
| DB is sole source of truth | Tasks 3, 5 |
| Markdown is one-way export | Task 3 (autoExport gate) + Task 6 (export command) |
| Consolidation deletes stale markdown | Task 4 |
| No zombie entries on rebuild | Task 5 (INSERT OR IGNORE) |
| Rebuild still works for legacy migration | Task 5 (INSERT OR IGNORE still inserts new entries) |
| `autoExport: true` keeps markdown for git-trackable teams | Tasks 1 + 3 |
| `gyst export` command | Task 6 |
| `markdown_path` tracked in DB | Tasks 2, 3, 4, 6 |

**Placeholder scan:** All steps include actual code. No "implement later" items.

**Type consistency:** `markdown_path: string | null` used consistently across all tasks. `ExportResult.exported/skipped` defined in Task 6 and used only in Task 6.
