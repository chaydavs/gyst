# Prompt 4 Integration + Brain-Like Learning + Final Verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining 4 integration gaps left from Prompts 1–3, fix the 1 failing test (recall scope bug), and deliver a clean final state with all 842+ tests passing, updated benchmarks, and updated docs.

**Architecture:** Five targeted code changes (ghost boost, style-fingerprint wiring, recall scope fix), then a documentation pass and final benchmark run. No new files needed — all changes are edits to existing files.

**Tech Stack:** Bun, TypeScript strict, bun:sqlite, @modelcontextprotocol/sdk

---

## What Is Already Done (Do Not Redo)

- Part A: `search.ts` + `recall.ts` both call `recordCoRetrieval` on top-5 results ✓
- Part B: `learn.ts` calls `createRelationship` for shared entity tags ✓  
- Part C: `feedback.ts` runs `UPDATE entries SET confidence` immediately ✓
- `consolidate.ts` Stage 2.5 runs `processCoRetrievals` between dedupe and merge ✓
- `graph.ts` registered as the 14th MCP tool ✓
- `style-fingerprint.ts` fully implemented (451 lines) ✓
- `ghost-init.ts` calls `embedAndStore` after `insertEntry` ✓
- `database.ts` has uncommitted changes: `metadata` column migration + `insertEntry` update ✓ (just needs committed)
- `entities.ts` has uncommitted changes: Pattern 9 (file-path entity extraction) ✓ (just needs committed)

## Files Modified by This Plan

| File | Action | What Changes |
|------|--------|-------------|
| `src/mcp/tools/recall.ts` | Modify | Ghost boost +0.1 → +0.15 |
| `src/mcp/tools/learn.ts` | Modify | Add `fingerprintFile` import, call it when content exists, add `metadata` to INSERT SQL |
| `src/store/search.ts` | Modify | `searchByBM25` accepts optional `includeAllPersonal` flag; 3rd SQL path with no scope filter |
| `src/mcp/tools/recall.ts` | Modify | Pass `includeAllPersonal=true` when mode='personal' and no developerId |
| `src/mcp/tools/search.ts` | Modify | Pass `includeAllPersonal=true` when mode='personal' and no developerId |
| `CLAUDE.md` | Modify | Updated architecture section and tool list |
| `README.md` | Modify | Benchmark numbers and feature list |
| `.claude/memory/MEMORY.md` + `project_gyst.md` | Modify | Final state |

---

## Task 1: Commit Uncommitted Changes

**Files:**
- Commit: `src/compiler/entities.ts` — file-path entity extraction (Pattern 9)
- Commit: `src/store/database.ts` — metadata column migration + `insertEntry` update

- [ ] **Step 1: Verify the diff is clean**

```bash
git diff --stat src/compiler/entities.ts src/store/database.ts
```

Expected: 15 lines in entities.ts (path pattern), 13 lines in database.ts (metadata column).

- [ ] **Step 2: Stage and commit**

```bash
git add src/compiler/entities.ts src/store/database.ts
git commit -m "feat(entities): add file-path pattern + metadata column for style fingerprint"
```

---

## Task 2: Part D — Bump Ghost Knowledge Boost from +0.1 to +0.15

**Files:**
- Modify: `src/mcp/tools/recall.ts:253`

`★ Insight ─────────────────────────────────────`
Ghost knowledge entries are mandatory team-wide constraints (architecture rules,
security patterns). The higher +0.15 boost compensates for the fact that ghost
entries often use abstract/formal language (unlike the casual phrasing in queries),
making semantic similarity scores systematically lower than they should be.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write the failing benchmark test** (optional — skip if only aiming for test suite pass)

The ghost hit-rate test is in `tests/benchmark/` — no new test needed, this fix is validated by the benchmark run in Task 7.

- [ ] **Step 2: Make the change**

In `src/mcp/tools/recall.ts`, find:
```typescript
            if (e.type === "ghost_knowledge") {
              boosted = Math.min(1.0, base + 0.1);
```

Replace with:
```typescript
            if (e.type === "ghost_knowledge") {
              boosted = Math.min(1.0, base + 0.15);
```

This is line 252–253 in the current file.

- [ ] **Step 3: Run the recall unit tests to verify nothing breaks**

```bash
bun test tests/mcp/ 2>&1 | tail -10
```

Expected: all recall tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/recall.ts
git commit -m "feat(recall): increase ghost_knowledge RRF boost from 0.10 to 0.15"
```

---

## Task 3: Part E — Wire Style Fingerprint into learn.ts

**Files:**
- Modify: `src/mcp/tools/learn.ts` — add import, call `fingerprintFile`, add `metadata` to INSERT SQL

`★ Insight ─────────────────────────────────────`
Style fingerprinting works on *voting*: each line casts a vote for indentation,
semicolons, quotes, and trailing commas. A single file's fingerprint feeds into
a per-entry metadata field; over many entries, the uniformity score aggregates
these votes to compute team-wide style dominance — no external linter needed.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write a failing test**

In `tests/mcp/tools.test.ts`, add inside the learn describe block:

```typescript
test("learn stores style fingerprint in metadata for code content", async () => {
  const db = initDatabase(":memory:");
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerAllTools(server, { mode: "personal", db });

  const response = await callTool(server, "learn", {
    type: "convention",
    title: "Use single quotes in JS",
    content: "const x = 'hello';\nconst y = 'world';\nconst z = 'foo';",
    tags: [],
    files: [],
  });
  const text = getText(response);
  expect(text).toContain("stored");

  // Verify metadata was stored
  const row = db.query<{ metadata: string | null }, []>(
    "SELECT metadata FROM entries LIMIT 1"
  ).get();
  expect(row).not.toBeNull();
  const meta = JSON.parse(row!.metadata!);
  expect(meta.quotes).toBe("single");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/mcp/tools.test.ts --grep "style fingerprint" 2>&1 | tail -15
```

Expected: FAIL — `row.metadata` is null because learn.ts doesn't store it yet.

- [ ] **Step 3: Add fingerprintFile import to learn.ts**

At the top of `src/mcp/tools/learn.ts`, after the existing imports, add:

```typescript
import { fingerprintFile } from "../../compiler/style-fingerprint.js";
```

- [ ] **Step 4: Add metadata to the entry object in the handler**

In `src/mcp/tools/learn.ts`, inside `registerLearnTool`, find the section where `entry` is built before calling `persistEntry`. It looks like:

```typescript
    const entry = {
      id: crypto.randomUUID(),
      type: valid.type,
      title: valid.title,
      content: safeContent,
      // ... other fields
      scope: ...,
    };
```

Add a `metadata` field:

```typescript
    // Compute a style fingerprint when the content looks like source code.
    // We treat any content containing at least one semicolon or brace as code.
    const looksLikeCode = safeContent.includes(";") || safeContent.includes("{");
    const metadata = looksLikeCode
      ? JSON.stringify(fingerprintFile(safeContent))
      : null;

    const entry = {
      // ... existing fields unchanged ...
      metadata,
    };
```

- [ ] **Step 5: Add metadata to the INSERT SQL in persistEntry**

In `src/mcp/tools/learn.ts`, find the `db.run` INSERT in `persistEntry` at ~line 90:

```typescript
      db.run(
        `INSERT INTO entries
          (id, type, title, content, error_signature, confidence,
           source_count, created_at, last_confirmed, status, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          entry.id,
          entry.type,
          entry.title,
          entry.content,
          entry.errorSignature ?? null,
          entry.confidence,
          entry.sourceCount,
          entry.now,
          entry.now,
          entry.scope,
        ],
      );
```

Replace with:

```typescript
      db.run(
        `INSERT INTO entries
          (id, type, title, content, error_signature, confidence,
           source_count, created_at, last_confirmed, status, scope, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          entry.id,
          entry.type,
          entry.title,
          entry.content,
          entry.errorSignature ?? null,
          entry.confidence,
          entry.sourceCount,
          entry.now,
          entry.now,
          entry.scope,
          entry.metadata ?? null,
        ],
      );
```

This also requires that `persistEntry`'s parameter type includes `metadata?: string | null`. Find the type/interface for the entry parameter and add the field.

- [ ] **Step 6: Run the test to verify it passes**

```bash
bun test tests/mcp/tools.test.ts --grep "style fingerprint" 2>&1 | tail -15
```

Expected: PASS.

- [ ] **Step 7: Run all tests to check for regressions**

```bash
bun test tests/mcp/ 2>&1 | tail -10
```

Expected: same pass count as before.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/learn.ts
git commit -m "feat(learn): store style fingerprint as metadata on code entries"
```

---

## Task 4: Fix Recall Scope Bug — Personal Mode Must See Personal Entries

**Files:**
- Modify: `src/store/search.ts` — add `includeAllPersonal` param to `searchByBM25`
- Modify: `src/mcp/tools/recall.ts` — pass `includeAllPersonal` flag
- Modify: `src/mcp/tools/search.ts` — pass `includeAllPersonal` flag

`★ Insight ─────────────────────────────────────`
The scope design has three cases: (1) team mode with developer ID = see team + your personal,
(2) team mode no ID = see team only, (3) personal mode = there's only ONE user on this
installation so ALL entries are effectively "personal" — the scope filter should be dropped
entirely. Passing a boolean flag avoids coupling the DB layer to the transport concept of "mode."
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write the failing test**

The failing test already exists in `tests/integration/full-lifecycle.test.ts`, test 5:
```
(fail) tool: recall > 5. recall returns the timeout entry for a keyword query
```

Run it to confirm it fails:

```bash
bun test tests/integration/full-lifecycle.test.ts 2>&1 | grep -A 5 "fail\|FAIL"
```

Expected: 1 failure on test 5 (recall returns "No matching entries found").

- [ ] **Step 2: Update searchByBM25 signature in search.ts**

In `src/store/search.ts`, find the `searchByBM25` function signature at ~line 175:

```typescript
export function searchByBM25(
  db: Database,
  query: string,
  type?: string,
  developerId?: string,
): RankedResult[]
```

Change to:

```typescript
export function searchByBM25(
  db: Database,
  query: string,
  type?: string,
  developerId?: string,
  includeAllPersonal = false,
): RankedResult[]
```

- [ ] **Step 3: Add the third scope clause in searchByBM25**

In `src/store/search.ts`, find the scope clause logic at ~line 200:

```typescript
    const scopeClause =
      developerId
        ? `AND (e.scope IN ('team', 'project') OR (e.scope = 'personal' AND e.developer_id = ?))`
        : `AND e.scope IN ('team', 'project')`;
```

Replace with:

```typescript
    const scopeClause = developerId
      ? `AND (e.scope IN ('team', 'project') OR (e.scope = 'personal' AND e.developer_id = ?))`
      : includeAllPersonal
        ? ``  // personal mode: no scope filter — one user owns all entries
        : `AND e.scope IN ('team', 'project')`;
```

- [ ] **Step 4: Update recall.ts to pass includeAllPersonal**

In `src/mcp/tools/recall.ts`, find where `searchByBM25` is called in the `registerRecallTool` handler. It is called as part of the 5-strategy pipeline. The tool receives `ctx` which has `ctx.mode` and `ctx.developerId`.

Find the call sites (there may be 1-2 in the fused search block). Add the flag:

```typescript
const includeAllPersonal = ctx.mode === "personal" && !ctx.developerId;
```

Then pass `includeAllPersonal` as the 5th argument to `searchByBM25`:

```typescript
searchByBM25(db, query, input.type, developerId, includeAllPersonal)
```

Also update `fetchEntries` in recall.ts. Find `fetchEntries` at ~line 97. It has two SQL branches (with/without developerId). Add a third branch for `includeAllPersonal`:

```typescript
function fetchEntries(
  db: Database,
  ids: string[],
  developerId?: string,
  includeAllPersonal = false,
): EntryRow[] {
```

In the SQL logic, add the third path. Currently it's:

```typescript
      if (developerId) {
        // SELECT ... AND (scope IN ('team','project') OR (scope='personal' AND developer_id=?))
      } else {
        // SELECT ... AND scope IN ('team','project')
      }
```

Change to:

```typescript
      if (developerId) {
        // existing with-developerId SQL unchanged
      } else if (includeAllPersonal) {
        rows = db.query<EntryRow, [string]>(
          `SELECT id, type, title, content, confidence, scope
             FROM entries
            WHERE id IN (${placeholders})
              AND status = 'active'`,
          [...ids],
        ).all();
      } else {
        // existing team/project-only SQL unchanged
      }
```

Pass `includeAllPersonal` when calling `fetchEntries` in the tool handler:

```typescript
const rows = fetchEntries(db, topIds, developerId, includeAllPersonal);
```

- [ ] **Step 5: Update search.ts tool (src/mcp/tools/search.ts) similarly**

Find the `searchByBM25` call in the search tool handler and apply the same `includeAllPersonal` pattern. The search tool also uses `fetchEntries` or equivalent — apply the same fix.

- [ ] **Step 6: Run the integration test to verify the fix**

```bash
bun test tests/integration/full-lifecycle.test.ts 2>&1 | tail -15
```

Expected: 0 failures — all integration tests pass.

- [ ] **Step 7: Run full test suite**

```bash
bun test 2>&1 | tail -5
```

Expected: 842+ pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/store/search.ts src/mcp/tools/recall.ts src/mcp/tools/search.ts
git commit -m "fix(recall): personal mode shows all personal-scope entries when no developer_id"
```

---

## Task 5: Run Full Suite + Benchmark

- [ ] **Step 1: Run the full test suite**

```bash
bun test 2>&1 | tail -5
```

Expected: 842+ pass, 0 fail. If failures remain, fix them (they will be scope-related or import errors from the metadata changes).

- [ ] **Step 2: Run the lint check**

```bash
bun run lint 2>&1 | tail -20
```

Fix any lint errors before proceeding.

- [ ] **Step 3: Run the CodeMemBench benchmark**

```bash
bun run benchmark:codememb 2>&1 | tail -30
```

Record the new metrics:
- NDCG@10 (was 0.351)
- Ghost knowledge hit rate (was 76%, target 90%+)
- MRR@5 (was 0.844)

Save the output. These numbers go in README.md in Task 6.

---

## Task 6: Update Documentation

**Files:**
- Modify: `CLAUDE.md` — updated tool list, architecture section
- Modify: `README.md` — feature list and benchmark numbers
- Modify: `.claude/memory/project_gyst.md` — final project state
- Modify: `.claude/memory/MEMORY.md` — update the Gyst project state line

- [ ] **Step 1: Update CLAUDE.md tool list**

In the MCP Tools section of `CLAUDE.md`, add or update the tool list to include all 14 tools:

```
MCP Tools (14):
  learn, recall, conventions, failures, activity, status, feedback,
  harvest, check-conventions, search, get-entry, check, score, graph

CLI Commands:
  gyst setup, gyst ghost-init, gyst onboard, gyst score,
  gyst detect-conventions, gyst check <file>, gyst dashboard
```

Update the architecture section to mention:
- Co-retrieval recording on every search (auto-grows relationship graph)
- Entity-based auto-linking on every learn
- Real-time feedback confidence calibration (+0.02 / -0.05)
- Style fingerprint stored as JSON metadata on code entries

- [ ] **Step 2: Update README.md**

Add a "Benchmarks" section with the numbers from Task 5:

```markdown
## Benchmarks (CodeMemBench, April 2026)

| Metric | Score |
|--------|-------|
| NDCG@10 | 0.XXX |
| MRR@5 | 0.XXX |
| Ghost knowledge hit@5 | XX% |
| Convention hit rate | XX% |
```

Add a "Features" section listing all 14 MCP tools and 7 CLI commands.

- [ ] **Step 3: Update .claude/memory/project_gyst.md**

Update the file to reflect final state:
- 842+ tests passing
- 14 MCP tools
- All Parts A–H complete
- Final benchmark numbers

- [ ] **Step 4: Commit documentation**

```bash
git add CLAUDE.md README.md .claude/memory/project_gyst.md .claude/memory/MEMORY.md
git commit -m "docs: update CLAUDE.md, README.md, and memory with final Prompt 4 state"
```

---

## Task 7: Final Verification + Report

- [ ] **Step 1: Run bun test one last time**

```bash
bun test 2>&1 | tail -5
```

- [ ] **Step 2: Verify all 14 tools register on stdio transport**

```bash
grep -n "register.*Tool\|registerAll" src/mcp/register-tools.ts | wc -l
```

Expected: 14+ lines.

- [ ] **Step 3: Report final state to user**

```
Total tests passing: 842+
Total tests failing: 0
MCP tools (stdio): 14
MCP tools (HTTP): 14
MRR@5: [from benchmark]
NDCG@10: [from benchmark]
Ghost knowledge hit rate: [from benchmark, target ≥90%]
Uniformity score on Gyst codebase: [from `bun run gyst score`]
```

---

## Self-Review Against Spec

| Spec Part | Status | Task |
|-----------|--------|------|
| A: Co-retrieval in search + recall | ✓ Already done | — |
| A: Stage 2.5 processCoRetrievals | ✓ Already done | — |
| B: Entity-based auto-linking in learn | ✓ Already done | — |
| C: Feedback confidence ±0.02/0.05 | ✓ Already done | — |
| D: Ghost entries have embeddings | ✓ Already done (ghost-init.ts) | — |
| D: Ghost boost 0.1 → 0.15 | Task 2 | recall.ts:253 |
| E: fingerprintFile on code content | Task 3 | learn.ts |
| E: metadata stored in DB | Task 3 | learn.ts INSERT SQL |
| F: Integration lifecycle test | Task 4 fix | scope bug |
| F: 14 tools on both transports | ✓ Already done | — |
| G: 0 failing tests | Task 4 fix | scope bug |
| G: benchmark run | Task 5 | — |
| H: CLAUDE.md updated | Task 6 | — |
| H: README.md updated | Task 6 | — |
| H: MEMORY.md updated | Task 6 | — |
