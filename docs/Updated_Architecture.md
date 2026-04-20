# Gyst Architecture

Deep reference for contributors and for AI agents working in this codebase.

---

## Overview

Gyst is a SQLite-backed knowledge layer served over MCP (stdio and HTTP). Data flows in from hooks, git commits, and manual `learn()` calls. It flows out through `recall()`, context injection, context file export, and the React dashboard.

```
Inputs                    Core                      Outputs
──────                    ────                      ───────
git hooks ───────────┐                         ┌── recall() MCP (3 primary tools)
session hooks ───────┤                         │
MCP learn() calls ───┼──► SQLite DB ──────────►├── inject-context
dashboard UI ────────┘   (WAL mode)            │   (SessionStart always-on)
                           │                   │
                           ├── entries         ├── first-prompt injection
                           ├── relationships   │   (UserPromptSubmit, first only)
                           ├── structural_*    │
                           ├── co_retrievals   ├── context file export
                           ├── usage_metrics   │   (.cursorrules / AGENTS.md /
                           ├── drift_snapshots │    CLAUDE.md / .windsurfrules /
                           └── anchor_queries  │    CONTEXT.md)
                                               │
                                               ├── dashboard UI (React, port 3579)
                                               │   SimpleView + AdvancedView
                                               └── graph MCP tool (extended)
```

---

## MCP Tool Surface

### Primary Tools (3 — always registered)

| Tool | Purpose |
|------|---------|
| `learn` | Record team knowledge with entity extraction and auto-linking |
| `recall` | Multi-mode search: full recall, index, single entry, conventions, failures |
| `check` | Run all violation detectors against a file |

### Extended Tools (5 — gated behind `exposeExtendedTools: true`)

| Tool | Purpose | Was previously |
|------|---------|---------------|
| `graph` | Query the knowledge relationship graph | unchanged |
| `feedback` | Rate entries helpful/unhelpful | unchanged |
| `harvest` | Extract knowledge from a session transcript | unchanged |
| `status` | Health check + team activity summary | absorbs `activity` |
| `configure` | Read/write project configuration | unchanged |

Enable extended tools in `.gyst-wiki.json`:
```json
{ "exposeExtendedTools": true }
```
Or via CLI: `gyst configure --extended-tools`.

### Recall Modes (all via the single `recall` tool)

The `recall` tool absorbs four formerly-separate tools via its `mode` parameter:

| Mode | What it does | Previously |
|------|-------------|-----------|
| `search` (default) | Full ranked recall with RRF fusion | `recall` |
| `index` | Compact token-efficient index (id · type · confidence · title) | `search` |
| `single` | Full content for one entry by id | `get_entry` |
| `conventions` | List team coding standards by directory/tags | `conventions` |
| `failures` | Look up known error patterns by error message | `failures` |

---

## Persistence: why data survives restarts

Every table is created with `CREATE TABLE IF NOT EXISTS` — schema initialization is fully idempotent. The database file lives at `.gyst/wiki.db` (resolved to the git root, not the cwd) and is never deleted by normal operation.

Three SQLite pragmas applied on every connection open:
```sql
PRAGMA journal_mode = WAL;    -- concurrent reads while writes are in progress
PRAGMA foreign_keys = ON;     -- referential integrity enforced
PRAGMA synchronous = NORMAL;  -- safe write durability without fsync on every write
```

WAL mode means: multiple readers + one writer can be active simultaneously. The dashboard server, MCP server, and git hook processes all share the same file safely. Schema migrations apply incrementally via `SCHEMA_MIGRATION_STEPS` — each step only runs if it has not been recorded in `system_config`.

**Result:** restart the dashboard server, MCP server, or any CLI command — the data is always read from the same on-disk file, exactly as it was left.

---

## Context Injection Architecture

There are two injection layers. Both add knowledge to the agent's context without requiring any `recall()` call.

### Layer 1 — SessionStart: always-on ghost knowledge

`session-start.js` runs `gyst inject-context --always-on --graph-traverse` **synchronously** and returns the result as `additionalContext` in the hook response. Claude Code prepends this to the agent's system context before the first message.

Contents:
- All active `ghost_knowledge` entries (confidence 1.0)
- Top conventions for the current working directory
- Recent team activity summary
- Drift warning if drift score > 0.4

This layer fires on every session, unconditionally.

### Layer 2 — UserPromptSubmit: first-prompt recall

`prompt.js` fires on every user message but only performs context injection on the **first prompt of a session**. Subsequent prompts are purely observational.

**First-prompt detection** uses a flag file keyed by `sessionId`:
```
tmpdir()/.gyst-sessions/{sessionId}-injected
```

On the first prompt:
1. The flag file is written immediately (prevents infinite retry on crash)
2. `gyst recall <promptText> -n 3 --format json` runs synchronously (1500ms timeout)
3. If results are returned, they are formatted as `## Task-Relevant Context (from gyst)` and injected as `additionalContext`
4. The agent receives task-relevant knowledge before it begins responding

**Cleanup lifecycle:**
- 24h opportunistic cleanup: flag files older than 24h are deleted on each hook firing
- On `session_end`, the flag file for the session is deleted

The two-layer model means:
- `SessionStart` delivers standing team knowledge (rules, conventions, ghost entries)
- `UserPromptSubmit` delivers task-specific knowledge tuned to what the user is asking

---

## Context File Export (`gyst export-context`)

Generates static context files in the project root so agents that do not support MCP still receive team knowledge.

### Output Files by Agent

| Agent | File | Format |
|-------|------|--------|
| Claude Code | `CLAUDE.md` | Managed section with BEGIN/END GYST CONTEXT markers |
| Cursor | `.cursorrules` | Instructional header + sections |
| Codex CLI | `AGENTS.md` | ## Rules / ## Conventions / ## Architecture |
| Windsurf | `.windsurfrules` | Same format as `.cursorrules` |
| Gemini CLI / fallback | `CONTEXT.md` | Generic markdown |

### Marker-based idempotency (CLAUDE.md)

CLAUDE.md is the only file that supports marker-based partial update. Re-running `gyst export-context` replaces only the Gyst section; the rest of the file is untouched. Other files (`.cursorrules`, `AGENTS.md`, etc.) are fully overwritten on each run.

### Content and Token Budget

Each export pulls from the KB:
- All active `ghost_knowledge` entries (always kept in full)
- Top 15 `convention` entries by confidence (threshold 0.4)
- Last 10 `decision` entries by recency
- Top 5 `error_pattern` entries by source count

A 16,000-character token budget is enforced with progressive truncation: error content → error count → convention content → convention count → decision count.

### Auto-regeneration

`gyst export-context` runs automatically after `gyst install` and `gyst init`. Manual re-run: `gyst export-context [--format claude|codex|cursor|windsurf|gemini] [--dry-run]`

---

## Knowledge Graph Architecture

There are **three distinct graph layers** in Gyst, each serving a different purpose:

### Layer 1 — Curated Graph (`relationships` table)

Human and LLM-authored edges between knowledge entries. Created by:
- The `linker.ts` compiler stage (extracts entity references from entry content and links them)
- The consolidation pipeline (3+ co-retrievals automatically promote to a real edge)
- Manual `learn()` calls that reference other entries

```sql
relationships (
  id         TEXT PRIMARY KEY,
  source_id  TEXT REFERENCES entries(id),
  target_id  TEXT REFERENCES entries(id),
  type       TEXT,     -- 'related_to', 'caused_by', 'contradicts', etc.
  strength   REAL      -- 0.0-1.0, boosted by co-retrieval count
)
```

This layer is **the primary retrieval signal**. Graph traversal in search (Strategy 3) walks one hop out from file-path seed entries, giving seeds score 2.0 and neighbors score 1.0.

### Layer 2 — Co-Retrieval Graph (`co_retrievals` table)

Implicit edges built automatically by observing which entries get fetched together.

Every `recall()` call records all returned entry IDs into `co_retrievals` via `recordCoRetrieval()`:
```sql
co_retrievals (
  entry_a  TEXT,  -- always < entry_b (canonical order)
  entry_b  TEXT,
  count    INTEGER,   -- incremented on every co-retrieval
  last_seen INTEGER   -- unix ms
)
```

**The feedback loop:** co-retrieval count >= 3 triggers the consolidation pipeline to auto-create a `relationships` edge during Stage 2.5. This means the graph grows richer with use — patterns the agents notice get encoded as permanent edges without any human intervention.

### Layer 3 — Structural Graph (`structural_nodes` + `structural_edges` tables)

AST-derived code structure imported from Graphify's `graph.json` output. Populated by `graphify-transformer.ts`. This layer is deliberately separate from `entries` — deterministic AST data should never pollute BM25 FTS, confidence scoring, or curated entry views.

**Current usage:** structural nodes appear in the dashboard graph view as a distinct layer (gray nodes vs. colored curated nodes). They are **not yet wired into recall retrieval** — this is a known gap (see below).

---

## Search Pipeline: how the graph plugs in

Five strategies run in parallel on every `recall()`:

```
query ──┬── Strategy 1: File path lookup ─────────────────┐
        ├── Strategy 2: BM25 / FTS5 ──────────────────────┤
        ├── Strategy 3: Graph traversal ──────────────────►├── RRF fusion ──► ranked results
        ├── Strategy 4: Temporal (recency-weighted) ───────┤   (k=60)
        └── Strategy 5: Semantic / vector (ONNX) ──────────┘
```

RRF fusion (k=60) converts rank positions to scores: sum of 1/(60 + rank) per document across all lists. Ghost knowledge entries get an additional +0.15 RRF boost and are always placed in tier 0.

---

## Graph Query API (`store/graph.ts`)

Available to the `graph` MCP tool (extended) and the dashboard:

| Function | Algorithm | Use case |
|----------|-----------|----------|
| `getNeighbors(db, entryId)` | 1-hop expansion | "What is related to this entry?" |
| `getFileSubgraph(db, paths)` | Seed + 1-hop | "What knowledge lives around these files?" |
| `getClusters(db)` | BFS connected components | "What are the natural knowledge clusters?" |
| `findPath(db, from, to)` | BFS shortest path (max depth 6) | "How does A connect to B?" |
| `getHubs(db)` | Degree centrality (relationships + co_retrievals) | "What are the most central entries?" |
| `getFullGraph(db)` | Confidence-sorted, curated + structural layers | Dashboard visualization |

---

## Known graph gaps (improvement areas)

1. **1-hop only in retrieval** — Strategy 3 walks exactly one hop. 2-hop traversal would surface entries related-to-related.

2. **Structural layer not in retrieval** — Graphify AST nodes are only in the dashboard view. Wiring `structural_edges` into Strategy 3 would let queries about specific functions benefit from code structure.

3. **Hub boost not applied at recall time** — `getHubs()` exists but hub degree is not fed back as an RRF signal.

4. **Co-retrieval threshold is a fixed constant** — 3 co-retrievals to promote to a real edge. Could be adaptive.

---

## Dashboard Architecture

The dashboard at `localhost:3579` has two views controlled by `ViewModeContext` (persisted to `localStorage` under `gyst-view-mode`).

### SimpleView (default)

Four-section layout with an embedded graph panel:
- **Overview** — entry counts by type, drift score pill, recent activity
- **Review Queue** — low-confidence / decayed entries needing confirm or archive
- **Graph** — interactive knowledge graph (force-directed canvas)
- **Context Economics** — leverage ratio, token savings, intent breakdown

### AdvancedView

Full sidebar navigation + individual page components (same pages as SimpleView, plus Team management, Anchor manager, and full Feed with search and type filters).

### Component tree

```
App
├── ViewModeProvider (context + localStorage persistence, key: 'gyst-view-mode')
│   ├── ViewToggle (header button)
│   ├── SimpleView  (mode === 'simple')
│   │   ├── OverviewSection
│   │   ├── ReviewQueueSection
│   │   ├── GraphCanvas (embedded)
│   │   └── ContextEconomicsSection
│   └── AdvancedView (mode === 'advanced')
│       ├── Sidebar
│       └── page components (Feed, Graph, Team, Drift, Economics...)
```

---

## Local Analytics (`src/utils/analytics.ts`)

Tracks recall and learn events locally in `usage_metrics`. No external calls.

**Core metric:** `leverageRatio = tokensDelivered / tokensInvested`
- `tokensDelivered` = sum of `token_proxy` across all `recall` events (response byte length / 4)
- `tokensInvested` = sum of `token_proxy` across all `learn` events (entry content byte length / 4)

A ratio > 1.0 means the knowledge base is delivering more context than was invested writing it.

---

## AI Drift Detection (`src/utils/drift.ts`)

Measures knowledge base health degradation over time.

**Three signals:**
1. **Zero-result rate trend** — 7-day window vs 30-day baseline. Delta > 10pp adds +0.35 drift score
2. **Stale entries** — confidence < 0.4, not confirmed in 30+ days — score scales with count
3. **AI fatigue** — 10+ recalls in 7d with zero new learns adds +0.2, sets `fatigueWarning = true`

**Snapshots** — `drift_snapshots` stores one row per calendar day (idempotent). Auto-taken on `session_end`.

---

## Hooks Architecture (`plugin/`)

All hook scripts are fire-and-forget. They never block the agent loop.

```
Claude Code event
    → hook script (Node.js, ~1ms)
        → badge() writes ANSI status box to stderr
        → emitAsync() spawns detached child process
            → child writes event to event_queue (SQLite)
        → {continue: true} written to stdout immediately
```

**All 12 Claude Code hook events registered:**

| Event | Script | Action |
|-------|--------|--------|
| `SessionStart` | `session-start.js` | inject-context (sync); returns `additionalContext` |
| `UserPromptSubmit` | `prompt.js` | First prompt: recall + inject context. Subsequent: emit `prompt` event only |
| `InstructionsLoaded` | `instructions-loaded.js` | emit `md_changed` — re-ingest CLAUDE.md |
| `PreToolUse` | `pre-tool.js` | status badge; emit `kb_miss_signal` on Read tool |
| `PostToolUse` | `tool-use.js` | emit `tool_use` + sidecar ADR/plan detection |
| `PostToolUseFailure` | `tool-failure.js` | emit `tool_failure` → error_pattern extraction |
| `SubagentStart` | `subagent-start.js` | inject ghost knowledge as `additionalContext` |
| `Stop` | `session-end.js` | emit `session_end` → distillation + drift snapshot |
| `SubagentStop` | `session-end.js` | same as Stop |
| `PreCompact` | `pre-compact.js` | emit `session_end` with `reason: "pre_compact"` |
| `PostCompact` | `post-compact.js` | emit `drift_snapshot` |
| `FileChanged` (`**/*.md`) | `file-changed.js` | emit `md_changed` → immediate MD re-ingest |

---

## Data Flow: from event to knowledge entry

```
hook fires
    │
    ▼
event_queue (SQLite, status='pending')
    │
    ▼
background event loop (mcp/events.ts, polls every 5s)
    │
    ├── session_end    → harvest.ts → classify → entries
    ├── commit         → parse commit → entries
    ├── tool_use       → error extraction → error_pattern entries
    ├── tool_failure   → error text → error_pattern entry
    ├── md_changed     → ingest-md.ts → md_doc entry (hash-checked)
    ├── kb_miss_signal → recorded for drift scoring
    ├── drift_snapshot → drift.ts → drift_snapshots row
    └── plan_added     → markdown-adr parser → decision entries
                          │
                          ▼
                    entries table
                          │
                          ├── linker.ts → relationships
                          ├── graphify-transformer.ts → structural_nodes/edges
                          ├── consolidate.ts → merge duplicates, promote co-retrievals
                          └── entries_fts (FTS5 trigger keeps in sync automatically)
```

---

## Full Schema Reference

| Table | Purpose | Notes |
|-------|---------|-------|
| `entries` | Core knowledge records | Types: error_pattern, convention, decision, learning, ghost_knowledge, structural, md_doc |
| `entries_fts` | Full-text search index | porter stemmer, codeTokenize preprocessing |
| `relationships` | Curated graph edges | type + strength; auto-promoted from co_retrievals |
| `co_retrievals` | Implicit co-fetch graph | canonical pair order (entry_a < entry_b) |
| `structural_nodes` | Graphify AST nodes | rebuildable, never in FTS |
| `structural_edges` | Graphify AST edges | rebuildable |
| `entry_files` | Entry to file path mapping | seeds graph traversal in search |
| `entry_tags` | Entry to tag mapping | used by conventions mode in recall |
| `sources` | Provenance records | who/when/what per entry |
| `feedback` | User ratings on entries | adjusts confidence +0.02/-0.05 |
| `event_queue` | Incoming hook events | background loop drains this |
| `sessions` | Session tracking | links events to sessions |
| `system_config` | Schema migration state | key-value, records completed migrations |
| `consolidation_state` | Dedup pipeline cursor | tracks last-processed entry |
| `usage_metrics` | Local analytics | recall/learn events, intent, token proxy |
| `drift_snapshots` | Daily KB health snapshots | one row per calendar day |
| `anchor_queries` | Golden probe queries | BM25-probed on every drift report |
| `review_queue` | Low-confidence entries | surfaced in dashboard for confirm/archive |
| `teams` / `team_members` / `api_keys` | Team mode auth | HTTP transport only |
| `activity_log` | Team activity feed | per-developer event log |
