# Self-Documenting Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gyst's KB self-populate from codebase structure, MD files, and agent sessions so AI agents never need to read source files.

**Architecture:** Four layers — ghost knowledge (always tier 0), structural skeleton (Graphify AST → KB), MD document corpus (auto-ingested with hash-check), and harvest corpus (sessions + git hooks). Six new Claude Code hooks capture context at every lifecycle event. A `gyst self-document` command bootstraps the KB in under 10 seconds.

**Tech Stack:** Bun, TypeScript strict, bun:sqlite, commander CLI, gray-matter (frontmatter parsing), Anthropic SDK (Haiku for ghost generation), React 18 (dashboard canvas)

---

## File Map

**Create:**
- `src/compiler/ingest-md.ts` — MD file parser and KB ingester
- `src/cli/commands/self-document.ts` — three-phase bootstrap command
- `src/store/centrality.ts` — degree centrality for ghost auto-selection
- `plugin/scripts/pre-compact.js` — PreCompact hook: transcript harvest
- `plugin/scripts/post-compact.js` — PostCompact hook: verify + drift snapshot
- `plugin/scripts/instructions-loaded.js` — InstructionsLoaded hook: auto-ingest CLAUDE.md
- `plugin/scripts/file-changed.js` — FileChanged hook: MD reingest on save
- `plugin/scripts/tool-failure.js` — PostToolUseFailure hook: error_pattern extraction
- `plugin/scripts/subagent-start.js` — SubagentStart hook: inject ghost context
- `src/dashboard/ui/src/components/DocsTab.tsx` — Docs view component
- `tests/compiler/ingest-md.test.ts` — MD ingester tests
- `tests/store/centrality.test.ts` — centrality tests
- `tests/store/md-doc-type.test.ts` — DB migration tests
- `tests/cli/self-document.test.ts` — self-document command tests

**Modify:**
- `src/store/database.ts` — add `md_doc` to CHECK, add `source_file_hash` migration
- `src/dashboard/ui/src/components/GraphCanvas.tsx` — TYPE_COLOR + connection-count sizing
- `src/dashboard/ui/src/components/ModeRail.tsx` — add Docs tab
- `src/dashboard/ui/src/App.tsx` — wire Docs view
- `src/dashboard/ui/src/types.ts` — add `'docs'` to View, add `DocEntry` type
- `src/dashboard/ui/src/api.ts` — add `getDocs()`, `getDoc(id)`
- `src/dashboard/server.ts` — add `/api/docs` and `/api/docs/:id` routes
- `plugin/hooks/hooks.json` — add 6 new hooks + PreToolUse Read miss tracking
- `plugin/scripts/pre-tool.js` — add Read tool KB miss signal
- `src/store/events.ts` — add `md_changed`, `tool_failure`, `kb_miss_signal`, `drift_snapshot`
- `src/cli/index.ts` — register `self-document` command

---

## Task 1: Graph — Replace shade encoding with type colors

**Files:**
- Modify: `src/dashboard/ui/src/components/GraphCanvas.tsx`

- [ ] **Step 1: Confirm current state**

Run `bun run dev` inside `src/dashboard/ui/`. Open http://localhost:5173, navigate to Graph tab. Confirm all nodes are currently grey/monochrome.

- [ ] **Step 2: Replace TYPE_SHADE with TYPE_COLOR**

In `src/dashboard/ui/src/components/GraphCanvas.tsx`, replace lines 33–41:

```typescript
// Monochrome-friendly type shades — enough visual distinction without color
const TYPE_SHADE: Record<string, string> = {
  ghost_knowledge: '#111',
  error_pattern:  '#444',
  decision:       '#666',
  convention:     '#888',
  learning:       '#aaa',
  structural:     '#ccc',
};
```

With:

```typescript
const TYPE_COLOR: Record<string, string> = {
  ghost_knowledge: '#7c3aed',
  error_pattern:   '#dc2626',
  decision:        '#eab308',
  convention:      '#d97706',
  learning:        '#059669',
  md_doc:          '#0891b2',
  structural:      '#2563eb',
};
const STRUCTURAL_COLOR = '#6366f1';
```

- [ ] **Step 3: Update drawGraph to use TYPE_COLOR**

In `drawGraph` at line ~143, replace:

```typescript
const shade = node.layer === 'structural' ? '#ccc' : (TYPE_SHADE[node.type] ?? '#888');
const fill = isDimmed ? '#ebebeb' : (isHovered ? '#000' : shade);
```

With:

```typescript
const color = node.layer === 'structural' ? STRUCTURAL_COLOR : (TYPE_COLOR[node.type] ?? '#888');
const fill = isDimmed ? '#ebebeb' : color;
```

Also update the hover stroke for circles (line ~161) from `ctx.strokeStyle = '#000'` to `ctx.strokeStyle = color`.

- [ ] **Step 4: Update legend**

In the legend section (~line 360), replace `Object.entries(TYPE_SHADE)` with `Object.entries(TYPE_COLOR)`:

```typescript
{Object.entries(TYPE_COLOR).map(([type, color]) => (
  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0 }} />
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {type.replace(/_/g, ' ')}
    </span>
  </div>
))}
```

Update the structural legend entry (~line 371) to use `STRUCTURAL_COLOR`:

```typescript
<span style={{ width: '8px', height: '8px', background: STRUCTURAL_COLOR, flexShrink: 0 }} />
```

- [ ] **Step 5: Verify visually**

Refresh Graph tab. Ghost knowledge nodes = purple, error patterns = red, decisions = yellow, conventions = amber, learning = green, md_doc = cyan, structural = blue, file/function = indigo.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/ui/src/components/GraphCanvas.tsx
git commit -m "feat(graph): replace monochrome shading with distinct type colors"
```

---

## Task 2: Graph — Dynamic node sizing by connection count

**Files:**
- Modify: `src/dashboard/ui/src/components/GraphCanvas.tsx`

- [ ] **Step 1: Compute connection counts from edge list after data load**

In the `useEffect` that calls `fetch('/api/graph')` (~line 213), inside the `.then((data: GraphData) => {` block, add connection count computation **before** mapping nodes:

```typescript
// Compute degree per node from edge list
const connectionCounts = new Map<string, number>();
for (const edge of data.edges) {
  connectionCounts.set(edge.source, (connectionCounts.get(edge.source) ?? 0) + 1);
  connectionCounts.set(edge.target, (connectionCounts.get(edge.target) ?? 0) + 1);
}
```

- [ ] **Step 2: Replace static radius with dynamic sizing**

Replace the `nodesRef.current = data.nodes.map(n => ({` block. The current code sets `radius: n.layer === 'structural' ? 4 : 8`. Replace the entire `.map` with:

```typescript
nodesRef.current = data.nodes.map(n => {
  const count = connectionCounts.get(n.id) ?? 0;
  const isGhost = n.type === 'ghost_knowledge';
  const base = n.layer === 'structural' ? 3 : 5;
  const radius = isGhost ? 20 : Math.min(20, Math.max(base, base + count * 1.5));
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    layer: (n.layer === 'structural' ? 'structural' : 'curated') as 'curated' | 'structural',
    x: w / 2 + (Math.random() - 0.5) * 300,
    y: h / 2 + (Math.random() - 0.5) * 300,
    vx: 0,
    vy: 0,
    radius,
  };
});
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/ui/src/components/GraphCanvas.tsx
git commit -m "feat(graph): dynamic node sizing by connection count, ghost always 20px"
```

---

## Task 3: Database migration — add md_doc type and source_file_hash column

**Files:**
- Modify: `src/store/database.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/store/md-doc-type.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase } from '../../src/store/database.js';

const TEST_DB = '/tmp/gyst-test-md-doc.db';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

describe('md_doc type migration', () => {
  test('allows inserting md_doc entries', () => {
    const db = initDatabase(TEST_DB);
    const now = new Date().toISOString();
    expect(() => {
      db.run(
        `INSERT INTO entries (id, type, title, content, confidence, source_count, created_at, last_confirmed, status, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['test-md-1', 'md_doc', 'README.md', 'content', 0.9, 1, now, now, 'active', 'team']
      );
    }).not.toThrow();
    db.close();
  });

  test('entries table has source_file_hash column', () => {
    const db = initDatabase(TEST_DB);
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(entries)').all();
    expect(cols.map(c => c.name)).toContain('source_file_hash');
    db.close();
  });
});
```

Run: `bun test tests/store/md-doc-type.test.ts`
Expected: FAIL — "CHECK constraint failed: entries"

- [ ] **Step 2: Update ENTRIES_DDL to include md_doc and source_file_hash**

In `src/store/database.ts`, replace the `ENTRIES_DDL` constant to add `'md_doc'` to the type CHECK and `source_file_hash TEXT` column:

```typescript
const ENTRIES_DDL = `CREATE TABLE IF NOT EXISTS entries (
    id               TEXT    NOT NULL PRIMARY KEY,
    type             TEXT    NOT NULL CHECK (type IN ('error_pattern','convention','decision','learning','ghost_knowledge','structural','md_doc')),
    title            TEXT    NOT NULL,
    content          TEXT    NOT NULL DEFAULT '',
    file_path        TEXT,
    error_signature  TEXT,
    confidence       REAL    NOT NULL DEFAULT 0.5,
    source_count     INTEGER NOT NULL DEFAULT 1,
    source_tool      TEXT,
    created_at       TEXT    NOT NULL,
    last_confirmed   TEXT    NOT NULL,
    superseded_by    TEXT,
    status           TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','stale','conflicted','archived','consolidated')),
    scope            TEXT    NOT NULL DEFAULT 'team'
                            CHECK (scope IN ('personal','team','project')),
    developer_id     TEXT,
    metadata         TEXT,
    markdown_path    TEXT,
    source_file_hash TEXT
  )`;
```

- [ ] **Step 3: Add table-rebuild migration for existing DBs**

In `src/store/database.ts`, after the existing `markdown_path` ALTER TABLE migration block (~line 428), add:

```typescript
// Migration: expand entries type CHECK to include 'md_doc' and add source_file_hash.
// SQLite CHECK constraints require a table rebuild to modify.
try {
  const row = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'"
  ).get();
  if (row && !row.sql.includes("'md_doc'")) {
    db.transaction(() => {
      db.run(`CREATE TABLE entries_new (
        id               TEXT    NOT NULL PRIMARY KEY,
        type             TEXT    NOT NULL CHECK (type IN ('error_pattern','convention','decision','learning','ghost_knowledge','structural','md_doc')),
        title            TEXT    NOT NULL,
        content          TEXT    NOT NULL DEFAULT '',
        file_path        TEXT,
        error_signature  TEXT,
        confidence       REAL    NOT NULL DEFAULT 0.5,
        source_count     INTEGER NOT NULL DEFAULT 1,
        source_tool      TEXT,
        created_at       TEXT    NOT NULL,
        last_confirmed   TEXT    NOT NULL,
        superseded_by    TEXT,
        status           TEXT    NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','stale','conflicted','archived','consolidated')),
        scope            TEXT    NOT NULL DEFAULT 'team'
                                CHECK (scope IN ('personal','team','project')),
        developer_id     TEXT,
        metadata         TEXT,
        markdown_path    TEXT,
        source_file_hash TEXT
      )`);
      db.run("INSERT INTO entries_new SELECT *, NULL FROM entries");
      db.run("DROP TABLE entries");
      db.run("ALTER TABLE entries_new RENAME TO entries");
    })();
    logger.info("Migrated entries table: added md_doc type and source_file_hash");
  }
} catch (err) {
  logger.warn("entries md_doc migration skipped", {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/store/md-doc-type.test.ts
```
Expected: PASS (2 assertions)

- [ ] **Step 5: Run full test suite**

```bash
bun test --timeout 30000 2>&1 | tail -10
```
Expected: all existing tests still passing.

- [ ] **Step 6: Commit**

```bash
git add src/store/database.ts tests/store/md-doc-type.test.ts
git commit -m "feat(db): add md_doc entry type and source_file_hash column migration"
```

---

## Task 4: MD ingester — parse, hash-check, store

**Files:**
- Create: `src/compiler/ingest-md.ts`
- Create: `tests/compiler/ingest-md.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/compiler/ingest-md.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase } from '../../src/store/database.js';
import { ingestMdFile, scanMdFiles } from '../../src/compiler/ingest-md.js';

const TEST_DB = '/tmp/gyst-test-ingest-md.db';
const TEST_DIR = '/tmp/gyst-md-test-dir';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

describe('ingestMdFile', () => {
  test('creates a md_doc entry from a markdown file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'TEST.md');
    writeFileSync(filePath, '# Test Doc\n\nThis is content.\n\n## Section\nDetails.');
    const db = initDatabase(TEST_DB);

    const result = ingestMdFile(db, filePath, TEST_DIR);

    expect(result.created).toBe(true);
    const row = db.query<{ type: string; title: string; confidence: number; source_file_hash: string | null }, []>(
      "SELECT type, title, confidence, source_file_hash FROM entries WHERE type='md_doc' LIMIT 1"
    ).get();
    expect(row?.type).toBe('md_doc');
    expect(row?.title).toBe('Test Doc');
    expect(row?.confidence).toBeCloseTo(0.9);
    expect(row?.source_file_hash).toBeTruthy();
    db.close();
    unlinkSync(filePath);
  });

  test('skips unchanged files on second ingest', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'UNCHANGED.md');
    writeFileSync(filePath, '# Unchanged\nSame content.');
    const db = initDatabase(TEST_DB);

    const first = ingestMdFile(db, filePath, TEST_DIR);
    const second = ingestMdFile(db, filePath, TEST_DIR);

    expect(first.created).toBe(true);
    expect(second.skipped).toBe(true);
    db.close();
    unlinkSync(filePath);
  });

  test('reingest when file content changes', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filePath = join(TEST_DIR, 'CHANGING.md');
    writeFileSync(filePath, '# Original\nFirst version.');
    const db = initDatabase(TEST_DB);

    ingestMdFile(db, filePath, TEST_DIR);
    writeFileSync(filePath, '# Updated\nSecond version.');
    const result = ingestMdFile(db, filePath, TEST_DIR);

    expect(result.updated).toBe(true);
    const row = db.query<{ title: string }, []>(
      "SELECT title FROM entries WHERE type='md_doc' LIMIT 1"
    ).get();
    expect(row?.title).toBe('Updated');
    db.close();
    unlinkSync(filePath);
  });
});

describe('scanMdFiles', () => {
  test('returns md files and excludes non-md', () => {
    mkdirSync(join(TEST_DIR, 'docs'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'README.md'), '# Readme');
    writeFileSync(join(TEST_DIR, 'docs', 'arch.md'), '# Arch');

    const files = scanMdFiles(TEST_DIR);
    const names = files.map(f => f.split('/').pop());
    expect(names).toContain('README.md');
    expect(names).toContain('arch.md');
  });
});
```

Run: `bun test tests/compiler/ingest-md.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 2: Implement src/compiler/ingest-md.ts**

Create `src/compiler/ingest-md.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { glob } from "glob";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import matter from "gray-matter";
import { logger } from "../utils/logger.js";

export interface IngestResult {
  created?: boolean;
  updated?: boolean;
  skipped?: boolean;
  entryId?: string;
}

const MD_GLOB_PATTERNS = [
  "**/*.md",
  "!node_modules/**",
  "!.git/**",
  "!dist/**",
  "!gyst-wiki/**",
];

export function scanMdFiles(projectDir: string): string[] {
  try {
    return glob.sync(MD_GLOB_PATTERNS, { cwd: projectDir, absolute: true });
  } catch (err) {
    logger.warn("scanMdFiles failed", { error: String(err) });
    return [];
  }
}

function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function extractTitle(relPath: string, frontmatter: Record<string, unknown>, content: string): string {
  if (typeof frontmatter["title"] === "string" && frontmatter["title"].trim()) {
    return frontmatter["title"].trim();
  }
  const h1 = /^#\s+(.+)$/m.exec(content);
  if (h1) return h1[1]!.trim();
  return relPath.split("/").pop()?.replace(/\.md$/, "") ?? relPath;
}

function extractSectionSummary(content: string): string {
  const lines = content.split("\n");
  const headings: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) headings.push(line.replace(/^#+\s/, "").trim());
    if (headings.length >= 8) break;
  }
  return headings.join(" · ");
}

export function ingestMdFile(db: Database, filePath: string, projectDir: string): IngestResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    logger.warn("ingestMdFile: cannot read file", { filePath });
    return { skipped: true };
  }

  const hash = computeHash(raw);
  const relPath = relative(projectDir, filePath);

  const existing = db.query<{ id: string; source_file_hash: string | null }, [string]>(
    "SELECT id, source_file_hash FROM entries WHERE type='md_doc' AND file_path=? LIMIT 1"
  ).get(relPath);

  if (existing && existing.source_file_hash === hash) {
    return { skipped: true, entryId: existing.id };
  }

  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  const markdownContent = parsed.content;
  const title = extractTitle(relPath, frontmatter, markdownContent);
  const sections = extractSectionSummary(markdownContent);
  const excerpt = markdownContent.replace(/```[\s\S]*?```/g, "[code]").replace(/\n{3,}/g, "\n\n").slice(0, 2000);
  const content = sections ? `${sections}\n\n${excerpt}` : excerpt;
  const tags: string[] = Array.isArray(frontmatter["tags"]) ? (frontmatter["tags"] as string[]) : [];
  const now = new Date().toISOString();

  if (existing) {
    db.transaction(() => {
      db.run(
        "UPDATE entries SET title=?, content=?, source_file_hash=?, last_confirmed=? WHERE id=?",
        [title, content, hash, now, existing.id]
      );
      db.run("DELETE FROM entry_tags WHERE entry_id=?", [existing.id]);
      for (const tag of tags) {
        db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)", [existing.id, tag]);
      }
    })();
    logger.info("ingestMdFile: updated", { relPath });
    return { updated: true, entryId: existing.id };
  }

  const id = `md_doc_${hash}`;
  db.transaction(() => {
    db.run(
      `INSERT INTO entries (id, type, title, content, file_path, confidence, source_count, created_at, last_confirmed, status, scope, source_file_hash)
       VALUES (?, 'md_doc', ?, ?, ?, 0.9, 1, ?, ?, 'active', 'team', ?)`,
      [id, title, content, relPath, now, now, hash]
    );
    for (const tag of tags) {
      db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)", [id, tag]);
    }
    db.run("INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)", [id, relPath]);
  })();
  logger.info("ingestMdFile: created", { relPath, id });
  return { created: true, entryId: id };
}

export function ingestAllMdFiles(db: Database, projectDir: string): { created: number; updated: number; skipped: number } {
  const files = scanMdFiles(projectDir);
  let created = 0; let updated = 0; let skipped = 0;
  for (const f of files) {
    const r = ingestMdFile(db, f, projectDir);
    if (r.created) created++;
    else if (r.updated) updated++;
    else skipped++;
  }
  return { created, updated, skipped };
}
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/compiler/ingest-md.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/compiler/ingest-md.ts tests/compiler/ingest-md.test.ts
git commit -m "feat(compiler): MD file ingester — hash-check, frontmatter parse, section summaries"
```

---

## Task 5: Dashboard Docs tab

**Files:**
- Modify: `src/dashboard/ui/src/types.ts`
- Modify: `src/dashboard/ui/src/api.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/ui/src/components/ModeRail.tsx`
- Modify: `src/dashboard/ui/src/App.tsx`
- Create: `src/dashboard/ui/src/components/DocsTab.tsx`

- [ ] **Step 1: Add 'docs' to View type and DocEntry type**

In `src/dashboard/ui/src/types.ts` line 151, change:

```typescript
export type View = 'feed' | 'search' | 'queue' | 'graph' | 'team';
```

To:

```typescript
export type View = 'feed' | 'search' | 'queue' | 'graph' | 'docs' | 'team';
```

Add after the existing type definitions (before the last export):

```typescript
export interface DocEntry {
  id: string;
  title: string;
  content: string;
  file_path: string | null;
  created_at: string;
  last_confirmed: string;
  confidence: number;
}
```

- [ ] **Step 2: Add API methods to api.ts**

In `src/dashboard/ui/src/api.ts`, add to the `api` object (after `getDrift`):

```typescript
getDocs: () => apiFetch<DocEntry[]>('/api/docs'),
getDoc: (id: string) => apiFetch<DocEntry>(`/api/docs/${encodeURIComponent(id)}`),
```

Also add `DocEntry` to the import at line 1:

```typescript
import type { Entry, EntryDetail, TeamMember, TeamInfo, ReviewItem, Stats, Analytics, MemberStats, SearchResult, PendingInvite, TeamActivity, DriftReport, DocEntry } from './types';
```

- [ ] **Step 3: Add server routes to server.ts**

In `src/dashboard/server.ts`, after the `"/api/graph"` route block (~line 500), add before any catch-all:

```typescript
if (path === "/api/docs") {
  const docs = db.query<{
    id: string; title: string; content: string; file_path: string | null;
    created_at: string; last_confirmed: string; confidence: number;
  }, []>(
    "SELECT id, title, content, file_path, created_at, last_confirmed, confidence FROM entries WHERE type='md_doc' AND status='active' ORDER BY last_confirmed DESC"
  ).all();
  logAccess(requestId, method, path, start, 200);
  return jsonResponse(docs, 200, requestId);
}

const DOCS_ENTRY_RE = /^\/api\/docs\/([^/]+)$/;
const docsEntryMatch = DOCS_ENTRY_RE.exec(path);
if (docsEntryMatch) {
  const docId = decodeURIComponent(docsEntryMatch[1] ?? "");
  const doc = db.query<{
    id: string; title: string; content: string; file_path: string | null;
    created_at: string; last_confirmed: string; confidence: number;
  }, [string]>(
    "SELECT id, title, content, file_path, created_at, last_confirmed, confidence FROM entries WHERE id=? AND type='md_doc'"
  ).get(docId);
  if (!doc) {
    logAccess(requestId, method, path, start, 404);
    return jsonResponse({ error: "not found" }, 404, requestId);
  }
  logAccess(requestId, method, path, start, 200);
  return jsonResponse(doc, 200, requestId);
}
```

- [ ] **Step 4: Create DocsTab.tsx**

Create `src/dashboard/ui/src/components/DocsTab.tsx`:

```typescript
import { useState, useEffect } from 'react';
import { api } from '../api';
import type { DocEntry } from '../types';

export default function DocsTab() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [selected, setSelected] = useState<DocEntry | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDocs()
      .then(setDocs)
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, []);

  const selectDoc = async (id: string) => {
    const doc = await api.getDoc(id).catch(() => null);
    if (doc) setSelected(doc);
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', fontFamily: 'var(--font-mono)', color: '#bbb', fontSize: '12px' }}>
        Loading docs…
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div style={{ padding: '40px', fontFamily: 'var(--font-mono)', color: '#bbb', fontSize: '12px' }}>
        No markdown documents ingested yet. Run <code>gyst self-document</code> to bootstrap.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ width: '260px', flexShrink: 0, borderRight: '1px solid var(--line)', overflowY: 'auto', padding: '8px 0' }}>
        {docs.map(doc => (
          <button
            key={doc.id}
            onClick={() => void selectDoc(doc.id)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 16px', background: selected?.id === doc.id ? 'var(--sunken)' : 'transparent',
              border: 'none', borderLeft: selected?.id === doc.id ? '2px solid #0891b2' : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>
              {doc.title}
            </div>
            {doc.file_path && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', marginTop: '2px' }}>
                {doc.file_path}
              </div>
            )}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
        {selected ? (
          <>
            <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: '18px', marginBottom: '4px' }}>
              {selected.title}
            </h2>
            {selected.file_path && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)', marginBottom: '20px' }}>
                {selected.file_path}
              </div>
            )}
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.6, color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {selected.content}
            </pre>
          </>
        ) : (
          <div style={{ color: 'var(--ink-faint)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
            Select a document to preview.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add Docs tab to ModeRail**

In `src/dashboard/ui/src/components/ModeRail.tsx`, in the `viewTabs` array (~line 33), add `'docs'` between `'queue'` and `'team'`:

```typescript
const viewTabs: Array<{ key: View; label: string }> = [
  { key: 'feed', label: 'Feed' },
  { key: 'graph', label: 'Graph' },
  { key: 'queue', label: 'Review' },
  { key: 'docs', label: 'Docs' },
  { key: 'team', label: 'Team' },
];
```

- [ ] **Step 6: Wire Docs view in App.tsx**

In `src/dashboard/ui/src/App.tsx`, add import:

```typescript
import DocsTab from './components/DocsTab';
```

Find where other views render (near `{view === 'graph' && ...}`) and add:

```typescript
{view === 'docs' && (
  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
    <DocsTab />
  </div>
)}
```

- [ ] **Step 7: Build check**

```bash
cd src/dashboard/ui && bun run build 2>&1 | tail -10
```
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/ui/src/types.ts src/dashboard/ui/src/api.ts src/dashboard/server.ts \
        src/dashboard/ui/src/components/DocsTab.tsx src/dashboard/ui/src/components/ModeRail.tsx \
        src/dashboard/ui/src/App.tsx
git commit -m "feat(dashboard): Docs tab — MD document browser with file list and preview pane"
```

---

## Task 6: Six new hook scripts + event types

**Files:**
- Create: `plugin/scripts/pre-compact.js`, `post-compact.js`, `instructions-loaded.js`, `file-changed.js`, `tool-failure.js`, `subagent-start.js`
- Modify: `plugin/hooks/hooks.json`
- Modify: `plugin/scripts/pre-tool.js`
- Modify: `src/store/events.ts`

- [ ] **Step 1: Create pre-compact.js**

Create `plugin/scripts/pre-compact.js`:

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  badge("harvesting before compaction");
  emitAsync(gyst, "session_end", {
    sessionId: typeof input.session_id === "string" ? input.session_id : null,
    transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    reason: "pre_compact",
  });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
```

- [ ] **Step 2: Create post-compact.js**

Create `plugin/scripts/post-compact.js`:

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  badge("drift snapshot post-compact");
  emitAsync(gyst, "drift_snapshot", {
    sessionId: typeof input.session_id === "string" ? input.session_id : null,
    reason: "post_compact_snapshot",
  });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
```

- [ ] **Step 3: Create instructions-loaded.js**

Create `plugin/scripts/instructions-loaded.js`:

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  if (filePath) {
    badge("ingesting instructions file");
    emitAsync(gyst, "md_changed", {
      filePath,
      memoryType: typeof input.memory_type === "string" ? input.memory_type : "Project",
      reason: "instructions_loaded",
    });
  }
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
```

- [ ] **Step 4: Create file-changed.js**

Create `plugin/scripts/file-changed.js`:

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  if (filePath && filePath.endsWith(".md")) {
    badge("ingesting changed MD file");
    emitAsync(gyst, "md_changed", { filePath, reason: "file_changed" });
  }
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
```

- [ ] **Step 5: Create tool-failure.js**

Create `plugin/scripts/tool-failure.js`:

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  const error = typeof input.error === "string" ? input.error : null;
  if (error) {
    badge("extracting error pattern");
    emitAsync(gyst, "tool_failure", {
      error,
      toolName: typeof input.tool_name === "string" ? input.tool_name : null,
      sessionId: typeof input.session_id === "string" ? input.session_id : null,
      toolInput: input.tool_input ?? null,
    });
  }
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
```

- [ ] **Step 6: Create subagent-start.js**

Create `plugin/scripts/subagent-start.js`. Use `execFileSync` (not `execSync`) to avoid shell injection:

```javascript
#!/usr/bin/env node
/**
 * SubagentStart hook — inject ghost knowledge into every spawned subagent.
 * Uses execFileSync with an argument array (no shell) to avoid injection risk.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const input = readHookInput();
  const gystBin = process.env.GYST_BIN || "gyst";

  let ghostContext = "";
  try {
    // execFileSync with array args — no shell, no injection risk
    const raw = execFileSync(
      gystBin,
      ["recall", "--type", "ghost_knowledge", "--limit", "3", "--format", "json"],
      { timeout: 2000, encoding: "utf8" }
    );
    const entries = JSON.parse(raw);
    if (Array.isArray(entries) && entries.length > 0) {
      ghostContext = "## Team Knowledge (gyst)\n" +
        entries.map((e) => `### ${e.title}\n${e.content}`).join("\n\n");
    }
  } catch {
    // ghost context is best-effort
  }

  process.stdout.write(JSON.stringify(
    ghostContext ? { continue: true, additionalContext: ghostContext } : { continue: true }
  ));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
```

- [ ] **Step 7: Update pre-tool.js to add KB miss tracking**

In `plugin/scripts/pre-tool.js`, after reading `hookInput` and before calling `badge(...)`, add:

```javascript
// Track Read tool calls as KB miss signals — agent needed source, KB didn't have it
if (hookInput.tool_name === "Read" && hookInput.tool_input?.file_path) {
  emitAsync(gyst, "kb_miss_signal", {
    filePath: hookInput.tool_input.file_path,
    sessionId: hookInput.session_id ?? null,
    reason: "read_tool_used",
  });
}
```

- [ ] **Step 8: Update hooks.json**

Replace the full content of `plugin/hooks/hooks.json` with:

```json
{
  "hooks": [
    { "event": "SessionStart", "script": "plugin/scripts/session-start.js", "timeout": 5000 },
    { "event": "UserPromptSubmit", "script": "plugin/scripts/prompt.js", "timeout": 500 },
    { "event": "InstructionsLoaded", "script": "plugin/scripts/instructions-loaded.js", "timeout": 500 },
    { "event": "PreToolUse", "matcher": "", "script": "plugin/scripts/pre-tool.js", "timeout": 500 },
    { "event": "PostToolUse", "matcher": "", "script": "plugin/scripts/tool-use.js", "timeout": 500 },
    { "event": "PostToolUseFailure", "matcher": "", "script": "plugin/scripts/tool-failure.js", "timeout": 500 },
    { "event": "SubagentStart", "matcher": "", "script": "plugin/scripts/subagent-start.js", "timeout": 2000 },
    { "event": "Stop", "script": "plugin/scripts/session-end.js", "timeout": 5000 },
    { "event": "SubagentStop", "script": "plugin/scripts/session-end.js", "timeout": 5000 },
    { "event": "PreCompact", "matcher": "", "script": "plugin/scripts/pre-compact.js", "timeout": 5000 },
    { "event": "PostCompact", "matcher": "", "script": "plugin/scripts/post-compact.js", "timeout": 2000 },
    { "event": "FileChanged", "matcher": "**/*.md", "script": "plugin/scripts/file-changed.js", "timeout": 500 }
  ]
}
```

- [ ] **Step 9: Add event types to src/store/events.ts**

Find the `EventType` union in `src/store/events.ts` and add:

```typescript
| 'md_changed'
| 'tool_failure'
| 'kb_miss_signal'
| 'drift_snapshot'
```

- [ ] **Step 10: Run lint**

```bash
bun run lint
```
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add plugin/scripts/pre-compact.js plugin/scripts/post-compact.js \
        plugin/scripts/instructions-loaded.js plugin/scripts/file-changed.js \
        plugin/scripts/tool-failure.js plugin/scripts/subagent-start.js \
        plugin/scripts/pre-tool.js plugin/hooks/hooks.json src/store/events.ts
git commit -m "feat(hooks): expand to 12 hooks — PreCompact, PostCompact, InstructionsLoaded, FileChanged, PostToolUseFailure, SubagentStart"
```

---

## Task 7: gyst self-document command

**Files:**
- Create: `src/cli/commands/self-document.ts`
- Create: `tests/cli/self-document.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing test**

Create `tests/cli/self-document.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase } from '../../src/store/database.js';
import { runSelfDocumentPhase1, runSelfDocumentPhase2 } from '../../src/cli/commands/self-document.js';

const TEST_DB = '/tmp/gyst-test-self-doc.db';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

describe('runSelfDocumentPhase1', () => {
  test('creates structural entries and returns counts', async () => {
    const db = initDatabase(TEST_DB);
    const result = await runSelfDocumentPhase1(db, process.cwd());
    expect(typeof result.created).toBe('number');
    expect(typeof result.updated).toBe('number');
    expect(result.created).toBeGreaterThanOrEqual(0);
    db.close();
  });
});

describe('runSelfDocumentPhase2', () => {
  test('ingests MD files and returns counts', async () => {
    const db = initDatabase(TEST_DB);
    const result = await runSelfDocumentPhase2(db, process.cwd());
    expect(typeof result.created).toBe('number');
    expect(result.created + result.updated + result.skipped).toBeGreaterThan(0);
    db.close();
  });
});
```

Run: `bun test tests/cli/self-document.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 2: Create src/cli/commands/self-document.ts**

Create `src/cli/commands/self-document.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { glob } from "glob";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../../utils/logger.js";
import { ingestAllMdFiles } from "../../compiler/ingest-md.js";
import { getTopCentralNodes } from "../../store/centrality.js";

export interface Phase1Result { created: number; updated: number; }
export interface Phase2Result { created: number; updated: number; skipped: number; }
export interface Phase3Result { written: number; tokensUsed: number; }

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function extractExports(content: string): string[] {
  const m = content.matchAll(/^export\s+(?:(?:async\s+)?function|class|const|let|type|interface|enum)\s+(\w+)/gm);
  return [...m].map(x => x[1]!).filter(Boolean);
}

function extractImports(content: string): string[] {
  const m = content.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm);
  return [...m].map(x => x[1]!).filter(Boolean);
}

export async function runSelfDocumentPhase1(db: Database, projectDir: string): Promise<Phase1Result> {
  const files = glob.sync(
    ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.test.ts", "!src/**/*.d.ts", "!node_modules/**", "!dist/**"],
    { cwd: projectDir, absolute: true }
  );
  let created = 0; let updated = 0;
  const now = new Date().toISOString();

  for (const filePath of files) {
    let content: string;
    try { content = readFileSync(filePath, "utf8"); } catch { continue; }

    const relPath = relative(projectDir, filePath);
    const exports = extractExports(content);
    const imports = extractImports(content);
    const parts: string[] = [];
    if (exports.length > 0) parts.push(`Exports: ${exports.slice(0, 10).join(", ")}`);
    if (imports.length > 0) parts.push(`Imports from: ${[...new Set(imports)].slice(0, 8).join(", ")}`);
    const moduleContent = parts.join("\n") || `Source file: ${relPath}`;
    const hash = shortHash(relPath + moduleContent);
    const id = `structural_${shortHash(relPath)}`;

    const existing = db.query<{ id: string; source_file_hash: string | null }, [string]>(
      "SELECT id, source_file_hash FROM entries WHERE id=?"
    ).get(id);

    if (existing && existing.source_file_hash === hash) continue;

    if (existing) {
      db.run("UPDATE entries SET title=?, content=?, source_file_hash=?, last_confirmed=? WHERE id=?",
        [relPath, moduleContent, hash, now, id]);
      updated++;
    } else {
      db.transaction(() => {
        db.run(
          `INSERT INTO entries (id, type, title, content, file_path, confidence, source_count, created_at, last_confirmed, status, scope, source_file_hash)
           VALUES (?, 'structural', ?, ?, ?, 0.8, 1, ?, ?, 'active', 'team', ?)`,
          [id, relPath, moduleContent, relPath, now, now, hash]
        );
        db.run("INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)", [id, relPath]);
      })();
      created++;
    }
  }
  logger.info("self-document phase 1 complete", { created, updated });
  return { created, updated };
}

export async function runSelfDocumentPhase2(db: Database, projectDir: string): Promise<Phase2Result> {
  return ingestAllMdFiles(db, projectDir);
}

export async function runSelfDocumentPhase3(
  db: Database,
  _projectDir: string,
  ghostCount: number,
  apiKey: string,
): Promise<Phase3Result> {
  const candidates = getTopCentralNodes(db, ghostCount);
  if (candidates.length === 0) {
    logger.info("self-document phase 3: no candidates for ghost generation");
    return { written: 0, tokensUsed: 0 };
  }

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  let written = 0; let tokensUsed = 0;
  const now = new Date().toISOString();

  for (const entry of candidates) {
    const ghostTitle = `How does ${entry.title.split("/").pop()?.replace(/\.tsx?$/, "") ?? entry.title} work?`;
    const ghostId = `ghost_${shortHash(ghostTitle)}`;

    const alreadyExists = db.query<{ id: string }, [string]>(
      "SELECT id FROM entries WHERE id=?"
    ).get(ghostId);
    if (alreadyExists) continue;

    const prompt = `You are documenting a codebase for AI agents. Write a concise, factual KB entry explaining what this module does and how it fits into the system, so an AI agent never needs to read the source file.

Module: ${entry.title}
Context: ${entry.content}

Write 2-4 sentences starting with "This module" or "This file". Focus on WHAT it does and HOW it connects to the rest of the system.`;

    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });
      const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      tokensUsed += (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0);
      if (!text) continue;

      db.run(
        `INSERT OR REPLACE INTO entries (id, type, title, content, confidence, source_count, created_at, last_confirmed, status, scope, metadata)
         VALUES (?, 'ghost_knowledge', ?, ?, 9999, 1, ?, ?, 'active', 'team', ?)`,
        [ghostId, ghostTitle, text, now, now, JSON.stringify({ sourceId: entry.id, generatedAt: now })]
      );
      written++;
    } catch (err) {
      logger.warn("ghost generation failed", { entryId: entry.id, error: String(err) });
    }
  }
  logger.info("self-document phase 3 complete", { written, tokensUsed });
  return { written, tokensUsed };
}
```

- [ ] **Step 3: Register self-document in CLI**

In `src/cli/index.ts`, add imports near the top:

```typescript
import { runSelfDocumentPhase1, runSelfDocumentPhase2, runSelfDocumentPhase3 } from "./commands/self-document.js";
```

Add the command registration after the existing command blocks:

```typescript
program
  .command("self-document")
  .description("Bootstrap the KB: structural skeleton + MD corpus + ghost knowledge")
  .option("--project-dir <path>", "Project root directory", process.cwd())
  .option("--ghost-count <n>", "Number of ghost entries to generate", "10")
  .option("--skip-ghosts", "Skip Phase 3 (no LLM calls)", false)
  .action(async (opts: { projectDir: string; ghostCount: string; skipGhosts: boolean }) => {
    const db = initDatabase();
    process.stdout.write("gyst self-document\n\n");

    process.stdout.write("Phase 1 — Structural skeleton…\n");
    const p1 = await runSelfDocumentPhase1(db, opts.projectDir);
    process.stdout.write(`  ${p1.created} created, ${p1.updated} updated\n`);

    process.stdout.write("Phase 2 — MD corpus…\n");
    const p2 = await runSelfDocumentPhase2(db, opts.projectDir);
    process.stdout.write(`  ${p2.created} ingested, ${p2.updated} updated, ${p2.skipped} skipped\n`);

    if (!opts.skipGhosts) {
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) {
        process.stdout.write("Phase 3 skipped — ANTHROPIC_API_KEY not set\n");
      } else {
        const n = parseInt(opts.ghostCount, 10);
        process.stdout.write(`Phase 3 — Ghost knowledge (top ${n})…\n`);
        const p3 = await runSelfDocumentPhase3(db, opts.projectDir, n, apiKey);
        process.stdout.write(`  ${p3.written} ghost entries written (${p3.tokensUsed} tokens)\n`);
      }
    }

    process.stdout.write("\nDone.\n");
    db.close();
  });
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/cli/self-document.test.ts
```
Expected: PASS

- [ ] **Step 5: Run lint**

```bash
bun run lint
```
Expected: clean.

- [ ] **Step 6: Smoke test**

```bash
bun run src/cli/index.ts self-document --skip-ghosts 2>&1 | head -15
```
Expected: Phase 1 + Phase 2 output with counts, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/self-document.ts tests/cli/self-document.test.ts src/cli/index.ts
git commit -m "feat(cli): gyst self-document — 3-phase KB bootstrap (structural + MD + ghost)"
```

---

## Task 8: Graph centrality

**Files:**
- Create: `src/store/centrality.ts`
- Create: `tests/store/centrality.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/store/centrality.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase } from '../../src/store/database.js';
import { computeDegreeCentrality, getTopCentralNodes } from '../../src/store/centrality.js';

const TEST_DB = '/tmp/gyst-test-centrality.db';

afterEach(() => { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

function insertEntry(db: ReturnType<typeof initDatabase>, id: string, title: string) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO entries (id, type, title, content, confidence, source_count, created_at, last_confirmed, status, scope)
     VALUES (?, 'learning', ?, '', 0.7, 1, ?, ?, 'active', 'team')`,
    [id, title, now, now]
  );
}

describe('computeDegreeCentrality', () => {
  test('returns empty map when no entries', () => {
    const db = initDatabase(TEST_DB);
    expect(computeDegreeCentrality(db).size).toBe(0);
    db.close();
  });

  test('hub node scores higher than leaf nodes', () => {
    const db = initDatabase(TEST_DB);
    insertEntry(db, 'hub', 'Hub');
    insertEntry(db, 'leaf1', 'Leaf1');
    insertEntry(db, 'leaf2', 'Leaf2');
    db.run(`INSERT INTO relationships (source_id, target_id, type) VALUES ('hub', 'leaf1', 'related_to')`);
    db.run(`INSERT INTO relationships (source_id, target_id, type) VALUES ('hub', 'leaf2', 'related_to')`);

    const centrality = computeDegreeCentrality(db);
    expect(centrality.get('hub')!).toBeGreaterThan(centrality.get('leaf1')!);
    db.close();
  });
});

describe('getTopCentralNodes', () => {
  test('returns at most N nodes', () => {
    const db = initDatabase(TEST_DB);
    for (let i = 0; i < 5; i++) insertEntry(db, `n${i}`, `Node ${i}`);
    expect(getTopCentralNodes(db, 3).length).toBeLessThanOrEqual(3);
    db.close();
  });
});
```

Run: `bun test tests/store/centrality.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 2: Implement src/store/centrality.ts**

Create `src/store/centrality.ts`:

```typescript
import type { Database } from "bun:sqlite";

export interface CentralNode {
  id: string;
  title: string;
  content: string;
  type: string;
  degree: number;
}

export function computeDegreeCentrality(db: Database): Map<string, number> {
  const rows = db.query<{ id: string; degree: number }, []>(`
    SELECT e.id,
           COALESCE(out_c.c, 0) + COALESCE(in_c.c, 0) + COALESCE(co.c, 0) AS degree
    FROM entries e
    LEFT JOIN (SELECT source_id AS id, COUNT(*) AS c FROM relationships GROUP BY source_id) out_c ON out_c.id = e.id
    LEFT JOIN (SELECT target_id AS id, COUNT(*) AS c FROM relationships GROUP BY target_id) in_c ON in_c.id = e.id
    LEFT JOIN (
      SELECT entry_a AS id, SUM(count) AS c FROM co_retrievals GROUP BY entry_a
      UNION ALL
      SELECT entry_b AS id, SUM(count) AS c FROM co_retrievals GROUP BY entry_b
    ) co ON co.id = e.id
    WHERE e.type NOT IN ('ghost_knowledge') AND e.status = 'active'
  `).all();

  const m = new Map<string, number>();
  for (const r of rows) m.set(r.id, r.degree);
  return m;
}

export function getTopCentralNodes(db: Database, n: number): CentralNode[] {
  return db.query<CentralNode, [number]>(`
    SELECT e.id, e.title, e.content, e.type,
           COALESCE(out_c.c, 0) + COALESCE(in_c.c, 0) AS degree
    FROM entries e
    LEFT JOIN (SELECT source_id AS id, COUNT(*) AS c FROM relationships GROUP BY source_id) out_c ON out_c.id = e.id
    LEFT JOIN (SELECT target_id AS id, COUNT(*) AS c FROM relationships GROUP BY target_id) in_c ON in_c.id = e.id
    WHERE e.type NOT IN ('ghost_knowledge', 'md_doc') AND e.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM entries g WHERE g.type = 'ghost_knowledge'
          AND g.metadata LIKE '%' || e.id || '%'
      )
    GROUP BY e.id
    ORDER BY degree DESC
    LIMIT ?
  `).all(n);
}
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/store/centrality.test.ts
```
Expected: PASS

- [ ] **Step 4: Run full test suite**

```bash
bun test --timeout 30000 2>&1 | tail -5
```
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/store/centrality.ts tests/store/centrality.test.ts
git commit -m "feat(store): degree centrality for ghost knowledge auto-selection"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: Full test suite**

```bash
bun test --timeout 30000 2>&1 | tail -10
```
Expected: all tests pass. Record the final count.

- [ ] **Step 2: Lint**

```bash
bun run lint
```
Expected: clean.

- [ ] **Step 3: Bootstrap the gyst KB**

```bash
gyst self-document --skip-ghosts
```
Expected: Phase 1 and 2 complete with counts. Verify with `gyst status`.

- [ ] **Step 4: Verify Docs tab**

Start `gyst dashboard`, open http://localhost:3579. Click Docs tab — ingested MD files should appear. Click CLAUDE.md — preview renders.

- [ ] **Step 5: Verify graph colors**

Click Graph tab — nodes should have distinct colors per type (not grey). Ghost nodes should be large purple circles.

- [ ] **Step 6: Verify recall hit**

```bash
gyst recall "how does the search pipeline work"
```
Expected: at least one result returned (structural entry for `src/store/search.ts`).

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: self-documenting KB complete — 4 layers, 12 hooks, graph colors, Docs tab, self-document command"
```
