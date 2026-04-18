# Gyst Architecture

Deep reference for contributors and for AI agents working in this codebase.

---

## Overview

Gyst is a SQLite-backed knowledge layer served over MCP (stdio and HTTP). Data flows in from hooks, git commits, and manual `learn()` calls. It flows out through `recall()`, `inject-context`, and the React dashboard.

```
Inputs                    Core                      Outputs
──────                    ────                      ───────
git hooks ───────────┐                         ┌── recall() MCP
session hooks ───────┤                         │
MCP learn() calls ───┼──► SQLite DB ──────────►├── inject-context
dashboard UI ────────┘   (WAL mode)            │   (SessionStart)
                           │                   ├── dashboard UI
                           ├── entries         │   (React, port 3579)
                           ├── relationships   └── graph MCP tool
                           ├── structural_*
                           ├── co_retrievals
                           ├── usage_metrics
                           ├── drift_snapshots
                           └── anchor_queries
```

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

`getHubs()` counts both `relationships` and `co_retrievals` when computing node degree, so entries that are frequently retrieved together naturally rise to the top of hub rankings.

### Layer 3 — Structural Graph (`structural_nodes` + `structural_edges` tables)

AST-derived code structure imported from Graphify's `graph.json` output. Populated by `graphify-transformer.ts`:

```sql
structural_nodes (id, label, file_path, file_type, source_location, norm_label, ...)
structural_edges (source_id, target_id, relation, weight)
```

This layer encodes things like: "function `getUserById` is defined in `src/auth/user.ts`", "class `AuthService` calls `validateToken`". It is **deliberately separate** from `entries` — deterministic AST data should never pollute BM25 FTS, confidence scoring, or curated entry views.

The structural layer is rebuildable at any time by re-running graphify and calling `transformGraphify()`. Losing it loses nothing that cannot be reconstructed.

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

**Strategy 3 detail:**
1. Extract file paths from the query context
2. Find all entries that reference those paths (`entry_files` table) → seed set, score 2.0
3. Walk one hop outward via `relationships` → neighbors, score 1.0
4. Return scored list for RRF fusion

**RRF fusion (k=60):** Each strategy returns a ranked list. RRF converts rank positions to scores: sum of 1/(60 + rank) per document across all lists. Documents that appear near the top of multiple strategies score highest. Ghost knowledge entries get an additional +0.15 RRF boost and are always placed in tier 0 of the response.

---

## Graph Query API (`store/graph.ts`)

Available to the `graph` MCP tool and the dashboard:

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

1. **1-hop only in retrieval** — Strategy 3 walks exactly one hop. 2-hop traversal would surface entries related-to-related, useful for broad "tell me about the auth system" queries.

2. **Structural layer not in retrieval** — Graphify AST nodes are only in the dashboard view. Wiring `structural_edges` into Strategy 3 would let queries like "what files are related to `validateToken`?" benefit from code structure.

3. **Hub boost not applied at recall time** — `getHubs()` exists but hub degree is not fed back as an RRF signal. High-degree entries (frequently co-retrieved) should rank higher.

4. **Co-retrieval threshold is a fixed constant** — 3 co-retrievals to promote to a real edge. Could be adaptive: lower for high-confidence entries, higher for low-confidence ones.

---

## Local Analytics (`src/utils/analytics.ts`)

Tracks recall and learn events locally in `usage_metrics`. No external calls.

**Core metric:** `leverageRatio = tokensDelivered / tokensInvested`
- `tokensDelivered` = sum of `token_proxy` across all `recall` events (response byte length / 4)
- `tokensInvested` = sum of `token_proxy` across all `learn` events (entry content byte length / 4)

A ratio > 1.0 means the knowledge base is delivering more context than was invested writing it.

**Intent classification** (local, 4 buckets — query text never stored):
- `debugging` — error/bug/crash keywords
- `temporal` — recent/last/history keywords
- `code_quality` — convention/pattern/refactor keywords
- `conceptual` — everything else

---

## AI Drift Detection (`src/utils/drift.ts`)

Measures knowledge base health degradation over time.

**Three signals:**
1. **Zero-result rate trend** — 7-day window vs 30-day baseline. Delta > 10pp adds +0.35 drift score
2. **Stale entries** — confidence < 0.4, not confirmed in 30+ days — score scales with count
3. **AI fatigue** — 10+ recalls in 7d with zero new learns adds +0.2, sets `fatigueWarning = true`

**Anchor queries** — golden probe queries stored in `anchor_queries`. Every drift report runs them against BM25 FTS. Broken anchors (0 results) indicate targeted knowledge loss.

**Snapshots** — `drift_snapshots` stores one row per calendar day (idempotent). Auto-taken on `session_end`. The 7-day vs 30-day comparison needs ~30 days of data before the trend label becomes meaningful (shows "unknown" until then).

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

The detached child process pattern (`spawn + unref()`) means the hook script exits before gyst has finished processing. Events are queued in `event_queue` and processed by the background event loop in the MCP server (polls every 5 seconds).

**All 6 Claude Code hook events registered:**

| Event | Script | Action |
|-------|--------|--------|
| `SessionStart` | `session-start.js` | `inject-context` (sync — must complete before agent starts) |
| `UserPromptSubmit` | `prompt.js` | emit `prompt` event (async) |
| `PreToolUse` | `pre-tool.js` | emit `pre_tool_use` event (async) |
| `PostToolUse` | `tool-use.js` | emit `tool_use` + sidecar ADR/plan detection (2 concurrent async emits) |
| `Stop` | `session-end.js` | emit `session_end` — triggers distillation + drift snapshot |
| `SubagentStop` | `session-end.js` | same as Stop |

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
    ├── session_end  → harvest.ts → classify → entries
    ├── commit       → parse commit → entries
    ├── tool_use     → error extraction → error_pattern entries
    └── plan_added   → markdown-adr parser → decision entries
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

## Dashboard Server (`src/dashboard/server.ts`)

The dashboard server is a `Bun.serve()` HTTP server that reads directly from the same SQLite database as the MCP server. There is no separate data layer or cache — every API call is a live SQL query.

Key design decisions:
- **No auth** — local/intranet only. Team mode authentication is handled at the HTTP MCP layer.
- **SSE for live updates** — `GET /api/events/stream` pushes `queue_changed` and `team_changed` events so the UI updates without polling.
- **Static React build** — `src/dashboard/dist/` is bundled into the CLI binary at build time via Bun's bundler.

---

## Full Schema Reference

| Table | Purpose | Notes |
|-------|---------|-------|
| `entries` | Core knowledge records | FTS5 virtual table kept in sync via trigger |
| `entries_fts` | Full-text search index | porter stemmer, codeTokenize preprocessing |
| `relationships` | Curated graph edges | type + strength; auto-promoted from co_retrievals |
| `co_retrievals` | Implicit co-fetch graph | canonical pair order (entry_a < entry_b) |
| `structural_nodes` | Graphify AST nodes | rebuildable, never in FTS |
| `structural_edges` | Graphify AST edges | rebuildable |
| `entry_files` | Entry ↔ file path mapping | seeds graph traversal in search |
| `entry_tags` | Entry ↔ tag mapping | used by conventions tool |
| `sources` | Provenance records | who/when/what per entry |
| `feedback` | User ratings on entries | adjusts confidence ±0.02/0.05 |
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
