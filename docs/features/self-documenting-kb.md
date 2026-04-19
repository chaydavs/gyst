# Self-Documenting Knowledge Base

## Overview

`gyst self-document` bootstraps the knowledge base directly from the codebase without requiring any manual entry. It runs in four sequential phases and can be invoked manually or triggered automatically by session hooks.

The command entry point is `src/cli/commands/self-document.ts`. Each phase is independent and can be re-run safely — all operations are idempotent.

```bash
gyst self-document [--skip-ghosts] [--no-llm] [--ghost-count N]
```

---

## Phase 1: Structural Skeleton

**Function**: `runSelfDocumentPhase1(db, projectDir)`

Globs all TypeScript source files under `src/**/*.{ts,tsx}`, excluding test files (`*.test.ts`), declaration files (`*.d.ts`), `node_modules/`, and `dist/`. For each file:

1. Extracts top-level named exports using a regex matching `export function`, `export class`, `export const`, `export type`, `export interface`, `export enum`
2. Extracts import specifiers from all import statements
3. Builds a compact content string:
   ```
   Exports: funcA, funcB, ClassC
   Imports from: ./utils, bun:sqlite, zod
   ```
4. Computes a content hash (`sha256(relPath + content)[:12]`)
5. Derives a stable entry ID: `structural_<sha256(relPath)[:12]>`
6. If the entry exists and the hash is unchanged, skips (no DB write)
7. If the entry exists but hash changed, updates title, content, and hash
8. If new, inserts with `type='structural'`, `confidence=0.8`, `scope='team'`, `status='active'`

Structural entries record the shape of the codebase — what each file exports and what it depends on. They serve as seeds for graph search and as sidecar context appended to recall results.

**Output**: `{ created: N, updated: M }`

---

## Phase 2: MD Corpus

**Function**: `runSelfDocumentPhase2(db, projectDir)`

Delegates to `ingestAllMdFiles(db, projectDir)` from `src/compiler/ingest-md.ts`. This scans the entire project directory for markdown files and ingests each as an `md_doc` entry.

For each `.md` file:
1. Reads and parses front matter with `gray-matter`
2. Extracts title from front matter or first H1 heading
3. Strips front matter, keeping only body content
4. Computes a content hash to skip unchanged files
5. Inserts or updates as `type='md_doc'` with `file_path` set to the relative path

Files this phase captures:
- `CLAUDE.md` — project instructions and rules
- `decisions/NNN-*.md` — ADRs
- `docs/**/*.md` — documentation
- `README.md`, changelogs, specs

**Output**: `{ created: N, updated: M, skipped: K }`

---

## Phase 3: Link

**Function**: `runSelfDocumentPhase3Link(db)`

Builds edges in the `relationships` table using SQL JOINs. All inserts use `INSERT OR IGNORE` so re-running is safe. Three strategies run in a single transaction:

### Strategy 1: Structural ↔ MD Doc (strength 0.6)

Links `structural` entries to `md_doc` entries where the paths are related by prefix. Example: `src/store/search.ts` structural entry gets linked to any doc whose path contains `search`.

```sql
INSERT OR IGNORE INTO relationships (source_id, target_id, type, strength)
SELECT s.id, d.id, 'related_to', 0.6
FROM entries s JOIN entries d
  ON d.type = 'md_doc'
  AND (s.file_path LIKE '%' || REPLACE(d.file_path, '.md', '') || '%'
    OR d.file_path LIKE '%' || s.file_path || '%')
WHERE s.type = 'structural' AND s.id < d.id
```

### Strategy 2: MD Doc ↔ MD Doc (strength 0.4)

Links sibling markdown documents — those in the same top-level directory. `decisions/001-foo.md` and `decisions/002-bar.md` become related.

### Strategy 3: Shared Tags (strength 0.4)

Links curated entries (`convention`, `learning`, `error_pattern`, `decision`) that share a tag. Restricted to tags shared by fewer than 8 entries to prevent fan-out from high-frequency tags in test fixtures.

**Output**: `{ edgesCreated: N }`

---

## Phase 4: Ghost Knowledge

Ghost knowledge entries are human-readable summaries of the most central nodes in the graph. They ensure AI agents never need to read source files directly — the summary explains what a module does and how it connects to the rest of the system.

### Hub Selection

`getTopCentralNodes(db, ghostCount)` from `src/store/centrality.ts` ranks entries by degree centrality (count of relationship edges + co-retrieval appearances). The top N entries that do not already have a ghost knowledge entry referencing them are selected as candidates.

### With LLM (`runSelfDocumentPhase4`)

Requires `ANTHROPIC_API_KEY`. For each candidate entry, calls `claude-haiku-4-5` with a prompt asking for a 2–4 sentence description of what the module does and how it connects to the system. The generated text is stored as a new `ghost_knowledge` entry:

- ID: `ghost_<sha256(ghostTitle)[:12]>`
- Title: `"How does <module> work?"`
- Content: Haiku-generated description
- `confidence = 1.0`, `scope = 'team'`, `status = 'active'`
- Metadata: `{ sourceId, generatedAt }` JSON

### Without LLM (`runSelfDocumentPhase4NoLLM`, via `--no-llm` flag)

Uses the candidate entry's existing content (trimmed to 600 chars) as the ghost knowledge body. No API call, no cost. The title follows the same `"How does X work?"` pattern.

**Output**: `{ written: N, tokensUsed: T }`

---

## Flags

### `--skip-ghosts`

Skips Phase 4 entirely. Runs only the structural skeleton (Phase 1), MD corpus (Phase 2), and link phase (Phase 3).

Used in the session hooks (`SessionStart`, `Stop`) where Phase 4 would be too slow or costly to run automatically. The KB is refreshed quickly with structural and document updates.

### `--no-llm`

Runs Phase 4 using the no-LLM path — promotes hub entries to ghost knowledge using their existing content, without calling the Anthropic API. Suitable for CI, offline use, or automated pipelines that should not incur API costs.

### `--ghost-count N`

Controls how many entries Phase 4 promotes. Default is typically 5. Ignored when `--skip-ghosts` is set.

---

## Session Hook Automation

Self-documenting runs automatically via two session hooks:

**SessionStart** (`plugin/scripts/session-start.js`):
```javascript
spawn(gyst, ["self-document", "--skip-ghosts", "--no-llm"], {
  detached: true, stdio: "ignore"
});
```
Runs phases 1–3 at the start of every session, detached so it never delays agent startup.

**Stop / SubagentStop** (`plugin/scripts/session-end.js`):
```javascript
spawn(gyst, ["self-document", "--skip-ghosts", "--no-llm"], {
  detached: true, stdio: "ignore"
});
```
Re-runs phases 1–3 at session end, picking up any files changed during the session.

Both invocations use `--skip-ghosts --no-llm` to avoid API calls during hook execution. Run `gyst self-document` manually (without flags) to generate LLM ghost knowledge on demand.

---

## Idempotency Guarantees

All four phases are safe to re-run:

- **Phase 1**: Hash-gated — unchanged files produce zero DB writes
- **Phase 2**: Hash-gated — unchanged markdown files are skipped
- **Phase 3**: `INSERT OR IGNORE` — existing edges are not duplicated
- **Phase 4**: ID-gated — `ghost_<hash>` entries are skipped if they already exist

Running `gyst self-document` repeatedly on an unchanged codebase has negligible overhead.

---

## Example Output

```
Phase 1 (structural): 47 created, 3 updated
Phase 2 (MD corpus): 12 created, 1 updated, 8 skipped
Phase 3 (link): 89 edges created
Phase 4 (ghost knowledge): 5 written, 1240 tokens used
```
