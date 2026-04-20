# Gyst — Technical Reference

Full reference for contributors, power users, and AI agents working in this codebase.

---

## System Architecture

Gyst is a SQLite-backed context layer served over MCP (stdio and HTTP). Data flows in from hooks, git commits, and `learn()` calls. It flows out through `recall()`, context injection at session start, and the React dashboard.

```
Inputs                    Core                      Outputs
──────                    ────                      ───────
git hooks ───────────┐                         ┌── recall() MCP
session hooks ───────┤                         │
MCP learn() calls ───┼──► SQLite DB ──────────►├── inject-context (SessionStart)
dashboard UI ────────┘   (WAL mode)            ├── dashboard UI (React, port 3579)
                           │                   └── graph MCP tool
                           ├── entries
                           ├── relationships
                           ├── co_retrievals
                           ├── structural_*
                           ├── usage_metrics
                           ├── drift_snapshots
                           └── anchor_queries
```

All writes use SQLite WAL mode — multiple readers and one writer can be active simultaneously. The dashboard server, MCP server, and git hook processes share the same `.gyst/wiki.db` file safely.

For the full schema and data-flow diagram, see [`docs/Updated_Architecture.md`](./Updated_Architecture.md).

---

## MCP Tool Reference

### Primary tools (always registered)

By default only three tools are exposed to agents. This keeps the agent's tool list short and focused.

#### `learn`

Record a new knowledge entry.

| Parameter | Type | Required | Description |
|---|---|:---:|---|
| `title` | string | ✓ | Short human-readable title |
| `content` | string | ✓ | The knowledge body (markdown) |
| `type` | string | ✓ | `error_pattern`, `convention`, `decision`, or `learning` |
| `files` | string[] | — | File paths this entry applies to |
| `tags` | string[] | — | Free-form tags |
| `confidence` | number | — | 0.0–1.0, defaults to 0.85 |

#### `recall`

Ranked search across all context entries. Returns up to 5000 tokens.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Natural language or code search query |
| `type` | string | Filter by entry type (optional) |
| `mode` | string | One of: `auto`, `temporal`, `debug`, `conventions`, `graph` |
| `file` | string | Seed results from a specific file path |
| `limit` | number | Max entries to return (default 10) |

**Five modes:**
- `auto` — intent classified automatically from query text
- `temporal` — recency-weighted; best for "what changed recently?"
- `debug` — error patterns surface first; best for stack traces
- `conventions` — conventions surface first; best for "how do we do X?"
- `graph` — graph traversal from a seed file; best for "what lives around this file?"

#### `check`

Run all convention violation detectors against a file path.

| Parameter | Type | Description |
|---|---|---|
| `file` | string | Absolute or relative path to check |

---

### Extended tools (opt-in)

Enable with:

```bash
gyst configure --extended-tools
```

Or set `"exposeExtendedTools": true` in `.gyst-wiki.json`.

| Tool | Purpose |
|---|---|
| `search` | Compact index (id/type/confidence/title) — 7× more token-efficient than `recall` for browsing |
| `get_entry` | Full markdown for one entry by ID |
| `conventions` | List coding standards scoped to a file path or directory |
| `check_conventions` | Which stored conventions apply to a file |
| `failures` | Match a known error pattern by signature or BM25 keywords |
| `graph` | Query the relationship graph — neighbors, shortest path, similar entries |
| `feedback` | Rate an entry helpful/unhelpful — adjusts confidence ±0.02 or ±0.05 |
| `harvest` | Extract knowledge from a raw session transcript |
| `activity` | Recent team activity log with developer attribution |
| `status` | Health check, database stats, entry counts |
| `configure` | Read or write project configuration from within an agent session |

---

## CLI Commands Reference

### Setup and installation

| Command | Flags | Description |
|---|---|---|
| `gyst init` | | First-time setup: DB, MCP config, hooks, codebase scan |
| `gyst serve` | `--http`, `--port N` | Start MCP server (stdio by default, HTTP for team mode) |
| `gyst setup` | | Legacy: create wiki directory structure only |

### Context management

| Command | Flags | Description |
|---|---|---|
| `gyst self-document` | `--skip-ghosts`, `--ghost-count N` | Bootstrap from codebase: structural + MD corpus + ghost knowledge |
| `gyst mine` | `--full`, `--commit <hash>`, `--no-llm` | Mine git history, comments, hot-path files, and integration tests |
| `gyst ghost-init` | | Interactive Q&A to capture tribal knowledge as ghost entries |
| `gyst detect-conventions` | `[dir]`, `--dry-run` | Scan directory for conventions and store them |
| `gyst export` | | Export all active entries to markdown files |
| `gyst onboard` | | Generate onboarding document from the context layer |

### Querying

| Command | Flags | Description |
|---|---|---|
| `gyst recall <query>` | `--type <type>`, `--max N`, `--format json` | Search the context layer |
| `gyst check <file>` | | Check a file against stored conventions |

### Team management

| Command | Description |
|---|---|
| `gyst create team <name>` | Create a team and print an admin API key |
| `gyst team invite` | Generate an invite key for a new member (`GYST_API_KEY` required) |
| `gyst team members` | List all team members |
| `gyst join <key> <name> [--server <url>]` | Join a team (local or remote HTTP server) |

### Dashboard and utilities

| Command | Description |
|---|---|
| `gyst dashboard` | Start the React dashboard at `localhost:3579` |
| `gyst add <title> [content]` | Manually add an entry from the CLI |
| `gyst configure` | Read/write `.gyst-wiki.json` config |

---

## Hook System

All 12 Claude Code lifecycle events are registered. Hook scripts are fire-and-forget — they never block the agent loop (detached spawn pattern, returns in under 1ms).

| Hook | Script | What happens |
|---|---|---|
| `SessionStart` | `session-start.js` | Inject ghost knowledge + top conventions (sync — must complete before agent starts) |
| `UserPromptSubmit` | `prompt.js` | Emit prompt event for knowledge classification |
| `InstructionsLoaded` | `instructions-loaded.js` | Re-ingest CLAUDE.md / instructions files into the context layer |
| `PreToolUse` | `pre-tool.js` | Write status badge to stderr; track `Read` calls as KB-miss signals |
| `PostToolUse` | `tool-use.js` | Emit tool_use event; detect ADR/plan writes as sidecar spawns |
| `PostToolUseFailure` | `tool-failure.js` | Extract `error_pattern` entry from failed tool output |
| `SubagentStart` | `subagent-start.js` | Inject ghost knowledge as `additionalContext` into every subagent |
| `Stop` | `session-end.js` | Trigger session distillation; fire incremental `mine` refresh |
| `SubagentStop` | `session-end.js` | Same distillation for subagent sessions |
| `PreCompact` | `pre-compact.js` | Harvest session knowledge before context is erased |
| `PostCompact` | `post-compact.js` | Take a drift snapshot after compaction completes |
| `FileChanged` (`**/*.md`) | `file-changed.js` | Re-ingest changed markdown files immediately on save |

**Multi-tool hook coverage** (`gyst init` writes configs for all detected tools):

| Tool | Config written | Events wired |
|---|---|---|
| Gemini CLI | `~/.gemini/settings.json` | SessionStart, SessionEnd, PreToolUse, PostToolUse |
| Cursor | `~/.cursor/hooks.json` | sessionStart, sessionEnd, preToolUse, postToolUse |
| Windsurf | `~/.codeium/windsurf/hooks.json` | pre_session, post_session, pre_tool_call, post_tool_call |
| Codex CLI | `~/.codex/hooks.json` | SessionStart, SessionEnd, PreToolUse, PostToolUse |

---

## Graph Layers

There are three distinct graph layers, each serving a different purpose:

**Layer 1 — Curated graph** (`relationships` table): Human and LLM-authored edges. Created by the `linker.ts` compiler stage, the consolidation pipeline (3+ co-retrievals auto-promote to a real edge), and `learn()` calls that reference other entries. This is the primary retrieval signal for search Strategy 3.

**Layer 2 — Co-retrieval graph** (`co_retrievals` table): Implicit edges built by observing which entries are fetched together. Every `recall()` call records the returned entry IDs as co-retrieval pairs. When count reaches 3, the consolidation pipeline auto-creates a `relationships` edge — the graph grows richer with use, with no human intervention required.

**Layer 3 — Structural graph** (`structural_nodes` + `structural_edges` tables): AST-derived code structure imported from `graph.json`. Encodes function/class/import relationships. Deliberately separate from entries — deterministic AST data does not pollute BM25, confidence scoring, or curated entry views. Visible in the dashboard graph view as gray nodes.

---

## Search Pipeline

Five strategies run in parallel on every `recall()`, fused with Reciprocal Rank Fusion (k=60):

```
query ──┬── Strategy 1: File path lookup ──────────────────┐
        ├── Strategy 2: BM25 / FTS5 (porter stemmer) ──────┤
        ├── Strategy 3: Graph traversal (1-hop) ───────────►├── RRF fusion ──► ranked results
        ├── Strategy 4: Temporal (recency-weighted) ────────┤
        └── Strategy 5: Semantic / vector (ONNX) ───────────┘
```

**RRF fusion:** Each strategy produces a ranked list. RRF scores = sum of `1/(60 + rank)` per document across all lists. Ghost knowledge entries get an additional +0.15 boost and are always placed in tier 0 of the response.

**Code tokenization:** All text is pre-processed with `codeTokenize()` before FTS5 insertion — splits camelCase, snake_case, and dot notation into separate tokens so `getUserName`, `get_user_name`, and `this.auth` all match the token `auth`.

---

## Confidence System

Every entry carries a `confidence` score from 0.0 to 1.0.

- Entries below **0.15** are excluded from all recall results
- Entries in the review queue are those below **0.85** for `error_pattern` and `ghost_knowledge` types, or ghost entries not confirmed in 30+ days
- The `feedback` tool adjusts confidence: helpful +0.05, unhelpful −0.02 (minor signal); explicit helpful +0.02

**Decay half-lives** (applied automatically during confidence maintenance runs):

| Type | Half-life |
|---|---|
| `error_pattern` | 30 days |
| `learning` | 60 days |
| `decision` | 365 days |
| `convention` | No decay (stable until explicitly changed) |
| `ghost_knowledge` | No decay (confidence held at 1.0) |

---

## Drift Detection

Measures context-layer health degradation over time. A drift score of 0.0 is healthy; 1.0 is severe.

**Three signals:**
1. **Zero-result rate trend** — 7-day window vs 30-day baseline. Delta > 10pp adds +0.35 to the drift score.
2. **Stale entries** — confidence < 0.4, not confirmed in 30+ days. Score scales with count.
3. **AI fatigue** — 10+ recalls in 7 days with zero new learns adds +0.2 and sets a fatigue warning.

**Anchor queries** — golden probe queries stored in the `anchor_queries` table. Every drift report runs them against BM25 FTS. Broken anchors (0 results) indicate targeted knowledge loss and are flagged by name in the dashboard.

**Snapshots** — one row per calendar day in `drift_snapshots` (idempotent). Auto-taken on every `session_end` event. The 7-day vs 30-day trend label requires ~30 days of data to become meaningful (shows "unknown" until then).

---

## Context Economics

Tracks the return on investment of your context layer. All data stays in your local SQLite database — no external calls, no opt-in.

**Leverage ratio** = tokens your agents received from recall ÷ tokens you invested writing entries.

- A ratio > 1.0 means the context layer is already paying for itself
- A ratio of 10 means every minute spent writing an entry saved ten minutes of context re-generation

The dashboard surfaces the leverage ratio, total token savings, zero-result rate, intent mix (debugging / temporal / code_quality / conceptual), and recalls and learns per day.

---

## Configuration Reference

Config file: `.gyst-wiki.json` in your project root. All keys are optional — missing keys fall back to defaults. Environment variables `GYST_DB_PATH` and `GYST_WIKI_DIR` override the config file.

| Key | Type | Default | Description |
|---|---|---|---|
| `wikiDir` | string | `"gyst-wiki"` | Directory for exported markdown files |
| `dbPath` | string | `".gyst/wiki.db"` | Path to the SQLite database file |
| `globalDbPath` | string | `~/.gyst/global.db` | Path to the global personal database |
| `maxRecallTokens` | number | `5000` | Hard token budget for recall responses |
| `confidenceThreshold` | number | `0.15` | Minimum confidence score for recall results |
| `logLevel` | string | `"info"` | Log level: `debug`, `info`, `warn`, `error` |
| `autoExport` | boolean | `false` | Write markdown files after every `learn()` call |
| `teamMode` | boolean | `false` | Enable team-scoped entries (set automatically by `gyst team init`) |
| `exposeExtendedTools` | boolean | `false` | Register 5 extended tools (graph, feedback, harvest, status, configure) in addition to the default 3 primary tools |

---

## CI/CD Integration

Run `gyst self-document --skip-ghosts` in CI to keep your context layer current from codebase changes without making any LLM API calls (zero cost, under 5 seconds):

```yaml
# GitHub Actions example
- name: Update context layer
  run: gyst self-document --skip-ghosts
  env:
    GYST_DB_PATH: .gyst/wiki.db
```

This runs Phases 1 and 2 only — structural skeleton and MD corpus — both of which are deterministic and require no API key. The `--skip-ghosts` flag bypasses Phase 3 (ghost knowledge generation via Haiku).

For post-commit hook mining in CI environments:

```bash
gyst mine --commit HEAD --no-llm
```
