# Knowledge Base: Entry Types, Confidence, and Lifecycle

## Overview

The knowledge base is a SQLite database (`gyst.db` by default) that stores structured knowledge entries. The `entries` table is the source of truth. Markdown files in `gyst-wiki/` are a derived export — generated on demand, never the primary record.

All agent interactions go through the MCP server. Direct database access is for internal tooling only.

---

## Entry Types

The `type` column is constrained to 7 values. Each type has different decay behaviour, default confidence, and search priority.

### `ghost_knowledge`

Hard team constraints that AI agents must never violate. Examples: "Never store raw API keys", "This service is read-only in production". Ghost entries are injected into every agent context at session start and always surface at tier 0 in search results — ahead of every other type, regardless of confidence score.

- Default confidence: `1.0` (fixed, never decays)
- Scope: always `team`
- Recall tier: 0 (always first)
- Created by: `learn` tool with `type: ghost_knowledge`, or promoted by `gyst self-document` Phase 4
- Storage: `status = 'active'`, `confidence = 1.0`

### `convention`

Coding standards, patterns, and style rules specific to this codebase. These are stable — they don't decay over time. Examples: "Use kebab-case for file names", "All async functions must have try/catch".

- Default confidence: `0.5` (no decay configured — stable until explicitly changed)
- Recall tier: 1
- Half-life: none (infinite)
- Created by: `learn` tool, convention detectors, or `gyst detect-conventions`

### `error_pattern`

Normalized error signatures paired with their fixes. The `error_signature` column stores the normalized pattern (file paths, line numbers, UUIDs, and timestamps replaced with placeholders). On `learn`, if a fingerprint collision is found, the existing entry is merged rather than duplicated.

- Default confidence: `0.5`
- Half-life: 30 days
- Fingerprint: `sha256(error_type + normalized_signature)` truncated to 12 chars
- Deduplication: checked against `error_signature` column before insert

### `decision`

Architectural and significant technical decisions. Equivalent to ADRs (Architecture Decision Records). These have long half-lives because decisions remain relevant for months or years.

- Default confidence: `0.5`
- Half-life: 365 days
- Created by: `learn` tool, or auto-detected from ADR markdown files in `decisions/`

### `learning`

General lessons, tips, and discoveries that don't fit the other categories. The most common entry type for organic knowledge capture.

- Default confidence: `0.5`
- Half-life: 60 days
- Created by: `learn` tool or `harvest` tool from session transcripts

### `structural`

Auto-generated entries representing TypeScript source files. Created by `gyst self-document` Phase 1. Each entry records the file's exported symbols and import dependencies. Stored with `confidence = 0.8` and `scope = 'team'`.

- ID format: `structural_<sha256_of_relpath[:12]>`
- Content: `"Exports: funcA, funcB\nImports from: ./utils, bun:sqlite"`
- Not exposed directly in recall results — used as graph seeds and sidecar context

### `md_doc`

Markdown documentation files ingested into the KB. Created by `gyst self-document` Phase 2 via `ingestAllMdFiles()`. Includes CLAUDE.md, ADRs in `decisions/`, specs, and any other `.md` files.

- Content: the full markdown text (stripped of front matter)
- File path stored in `file_path` column and `entry_files` join table
- Not returned as primary recall results; used as graph edges and sidecar

---

## The `entries` Table Schema

```sql
CREATE TABLE entries (
  id               TEXT NOT NULL PRIMARY KEY,      -- UUID or stable hash-based ID
  type             TEXT NOT NULL,                  -- one of 7 types above
  title            TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  file_path        TEXT,                           -- primary file (optional)
  error_signature  TEXT,                           -- normalized error (error_pattern only)
  confidence       REAL NOT NULL DEFAULT 0.5,      -- 0.0–1.0
  source_count     INTEGER NOT NULL DEFAULT 1,     -- times this entry was confirmed
  source_tool      TEXT,
  created_at       TEXT NOT NULL,
  last_confirmed   TEXT NOT NULL,
  superseded_by    TEXT,
  status           TEXT NOT NULL DEFAULT 'active', -- see Status Lifecycle
  scope            TEXT NOT NULL DEFAULT 'team',   -- personal | team | project
  developer_id     TEXT,                           -- owner for personal entries
  metadata         TEXT,                           -- JSON blob (classifier trail etc.)
  markdown_path    TEXT,                           -- set when autoExport is on
  source_file_hash TEXT                            -- content hash for structural entries
);
```

Supporting tables:
- `entry_files(entry_id, file_path)` — many-to-many files
- `entry_tags(entry_id, tag)` — free-form tags, including `entity:FunctionName` prefixed entity tags
- `sources(entry_id, developer_id, tool, session_id, git_commit, timestamp)` — full provenance
- `relationships(source_id, target_id, type, strength)` — graph edges

---

## Confidence System

Confidence is a single `[0.0, 1.0]` value that answers: **"how much should the agent trust this entry right now?"** It is computed by `calculateConfidence()` in `src/store/confidence.ts` and stored on the `entries.confidence` column.

### Initial Values

| Entry origin | Starting confidence |
|---|---|
| `learn` tool | `0.5` |
| Ghost knowledge | `1.0` (fixed, never decays) |
| Structural entries | `0.8` |

### Confidence Threshold

Entries with `confidence < config.confidenceThreshold` (default `0.15`) are excluded from all recall results. This is the archive floor — entries decay toward it, not past it (archival is a separate status transition).

---

### The Formula

```
saturation  = 1 - 1 / (1 + sourceCount)
decay       = 0.5 ^ (daysSinceLastConfirmed / halfLife)
raw         = saturation × decay
penalised   = raw
              × (hasContradiction ? 0.5 : 1.0)
              × (codeChanged      ? 0.7 : 1.0)
result      = clamp(penalised, 0.0, 1.0)
```

#### Factor 1: Source Saturation

How many independent sources have confirmed this entry? The saturation formula asymptotically approaches 1.0 — the marginal value of each additional confirmation halves.

```
saturation = 1 - 1 / (1 + sourceCount)
```

| Source count | Saturation |
|---|---|
| 1 | 0.50 |
| 3 | 0.75 |
| 7 | 0.875 |
| 9 | 0.90 |

#### Factor 2: Time Decay

Confidence decays over time according to each type's half-life. The formula is exponential — after exactly one half-life, the decay factor is 0.5. Conventions and ghost knowledge effectively never decay.

```
decay = 0.5 ^ (daysSinceLastConfirmed / halfLife)
```

| Type | Half-life | Behaviour |
|---|---|---|
| `ghost_knowledge` | ∞ | No decay — timeless constraints |
| `convention` | 9,999 days (~27 years) | Stable until explicitly changed |
| `decision` | 365 days | Architectural choices drift slowly |
| `learning` | 60 days | Observations fade as context evolves |
| `error_pattern` | 30 days | Fixes go stale as code changes |
| `structural` | none | Hash-gated update, no time decay |
| `md_doc` | none | No decay |

#### Factor 3: Contradiction Penalty (×0.5)

If a contradicting entry exists in the knowledge base, the score is halved. This signals that two entries disagree and human review is needed before the entry should be trusted.

#### Factor 4: Code-Changed Penalty (×0.7)

If the source file referenced by an entry has been modified since the entry was created, the score drops by 30%. The entry isn't necessarily wrong — but the code it describes has changed and needs re-verification.

---

### Confidence Adjustments (Post-Creation)

| Event | Change |
|---|---|
| Merge / re-confirmation | `source_count + 1`, `last_confirmed` updated |
| Feedback: helpful | `+0.02` (capped at 1.0) |
| Feedback: unhelpful | `−0.05` (floored at 0.0) |
| Consolidation decay pass | Recomputed from formula above |

---

## Scope

Every entry has a `scope` column: `personal`, `team`, or `project`.

- `team` — shared across all developers on the team (default in team mode)
- `personal` — visible only to the developer who created it (`developer_id` column must match)
- `project` — scoped to this project, visible to all (treated like team in most queries)

See `docs/features/team-vs-personal-knowledge.md` for full scope filtering rules.

---

## Status Lifecycle

```
active → stale → archived
active → consolidated   (after distillation merges multiple entries)
active → conflicted     (when a new entry contradicts an existing one)
```

| Status         | Meaning                                                   |
|----------------|-----------------------------------------------------------|
| `active`       | Normal, visible in search                                 |
| `stale`        | Low confidence, pending review in the review queue        |
| `conflicted`   | Contradicts another active entry; flagged for resolution  |
| `archived`     | Permanently excluded from search; kept for history        |
| `consolidated` | Merged summary of multiple related entries; still visible |

Entries with `status IN ('active', 'consolidated')` appear in recall results. `stale`, `conflicted`, and `archived` are excluded.

---

## ID Format

- Regular entries: `crypto.randomUUID()` — standard UUID v4
- Structural entries: `structural_<sha256(relPath)[:12]>`
- Ghost entries from self-document: `ghost_<sha256(ghostTitle)[:12]>`

The hash-based IDs make structural and ghost entries idempotent — re-running `self-document` will update rather than duplicate existing entries.

---

## FTS5 Index

The `entries_fts` virtual table mirrors the `entries` table's `title`, `content`, and `error_signature` columns. It uses the `porter unicode61` tokenizer for stemmed full-text search. Sync is maintained by three triggers:

- `entries_fts_ai` — INSERT trigger
- `entries_fts_ad` — DELETE trigger
- `entries_fts_au` — UPDATE trigger

Before text is inserted into FTS5, it is pre-processed by `codeTokenize()`: camelCase identifiers are split into individual tokens (`getUserName` → `get user name`), snake_case and dot notation are handled similarly. This ensures code symbol queries like `searchByFilePath` match even when the exact token is not present.

---

## Markdown Export

When `config.autoExport = true`, a markdown file is written to `gyst-wiki/` after every `learn` call. The path is stored in `entries.markdown_path`. If the file write fails, the database entry still exists — markdown is a derived artifact.

The `gyst export` command regenerates all markdown files from the current database state. Use it after restoring a backup or importing entries in bulk.
