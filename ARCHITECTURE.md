# Gyst Architecture

Full technical reference for the Gyst codebase. Covers every module, design decision, rejected alternative, and benchmark. Written for contributors, investors, and anyone who wants to understand how Gyst works under the hood.

**Last updated:** April 2026 | **Codebase:** ~23,000 lines TypeScript | **Tests:** 900+ across 62 files

## Table of Contents

- [What Gyst Is](#what-gyst-is)
- [Tech Stack](#tech-stack)
- [System Architecture](#system-architecture)
- [Data Model](#data-model)
- [Knowledge Ingestion Pipeline](#knowledge-ingestion-pipeline)
- [Search & Retrieval](#search--retrieval)
- [Confidence & Decay](#confidence--decay)
- [Classifier Pipeline](#classifier-pipeline)
- [Consolidation Engine](#consolidation-engine)
- [MCP Tools](#mcp-tools)
- [CLI](#cli)
- [Dashboard](#dashboard)
- [Plugin System](#plugin-system)
- [Capture Layer](#capture-layer)
- [Security](#security)
- [Benchmarks](#benchmarks)
- [Competitive Landscape](#competitive-landscape)
- [Decision Log](#decision-log)
- [Future Edits](#future-edits)

---

## What Gyst Is

AI coding agents make every developer faster but no team smarter. Gyst fixes that.

Gyst is the **team knowledge layer** for AI coding agents — open-format, self-hosted, and tool-agnostic. It captures conventions, error patterns, architectural decisions, and learnings from developer sessions and makes them available across every tool on the team via MCP. Works with Claude Code, Cursor, Codex CLI, Gemini CLI, Cline, Windsurf, and self-hosted LLMs — not locked to any one vendor.

Extends Karpathy's "LLM Wiki" pattern — where a single developer's context persists across sessions — to **teams**, where knowledge must be shared, deduplicated, decayed, and governed.

**One-liner:** The team knowledge layer for AI coding agents — open, self-hosted, tool-agnostic.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Bun | Built-in SQLite (no native addon pain), native TypeScript, fast startup (<100ms cold), single binary |
| Language | TypeScript strict mode | Type safety across the full stack; Zod for runtime validation |
| Database | SQLite via `bun:sqlite` | Single-file, zero-config, WAL mode for concurrent reads, FTS5 for text search |
| Search | FTS5 + sqlite-vec | BM25 for keyword search, MiniLM-L6-v2 embeddings for semantic search |
| MCP | @modelcontextprotocol/sdk | Standard protocol for AI tool integration; stdio + HTTP transports |
| CLI | Commander.js | Mature, well-typed, tree-shakeable |
| Validation | Zod | Runtime + compile-time type safety from one schema |
| Git | simple-git + parse-git-diff | Commit capture and diff analysis |
| Dashboard | React 18 + Vite + Tailwind | Editorial SPA at localhost:3579; D3.js legacy graph preserved at /legacy |

### Why not...

| Alternative | Why we rejected it |
|---|---|
| **PostgreSQL / Turso** | Adds a server process; SQLite is zero-config and fast enough for single-team scale (~10K entries). Turso sync is V2 for multi-team. |
| **Pinecone / Qdrant** | External vector DB is overkill; sqlite-vec gives us vector search in the same file as BM25/FTS5, with zero network hops. |
| **Node.js** | No built-in SQLite; requires native addons (better-sqlite3) which break across platforms. Bun bundles SQLite natively. |
| **Python** | MCP SDK is TypeScript-first; Python would add a second language and runtime. |
| **Redis / Memcached** | We need durability, not caching. SQLite with WAL gives us both persistence and concurrent read performance. |
| **Elasticsearch** | Heavy operational burden for a dev tool. FTS5 with porter stemmer + query expansion covers our search needs. |
| **LangChain / LlamaIndex** | Framework overhead for a simple pipeline. Direct Anthropic API calls are ~30 lines; no abstraction needed. |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        AI Coding Agents                     │
│  Claude Code │ Cursor │ Codex │ Gemini │ Cline │ Windsurf   │
└──────┬──────────┬──────────┬──────────┬──────────┬──────────┘
       │          │          │          │          │
       └──────────┴──────────┴──────────┴──────────┘
                           │ MCP (stdio/HTTP)
                           ▼
              ┌────────────────────────┐
              │      MCP Server        │
              │  14 tools, 2 transports│
              └───────────┬────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌───────────┐ ┌──────────────┐
   │  Compiler   │ │   Store   │ │   Capture    │
   │  Pipeline   │ │  (SQLite) │ │  (Git hooks) │
   └─────────────┘ └───────────┘ └──────────────┘
          │               │
          ▼               ▼
   ┌─────────────┐ ┌───────────┐
   │ Classifier  │ │  Search   │
   │ (3-stage)   │ │ (5-strat) │
   └─────────────┘ └───────────┘
```

### Data Flow

1. **Ingestion:** Agent calls `learn` → extract → validate → deduplicate → link → write to SQLite
2. **Retrieval:** Agent calls `recall` → 5 search strategies → RRF fusion → rank → format to token budget
3. **Passive capture:** Git hooks → classify event → promote if high-signal → consolidate
4. **Session harvest:** `harvest` tool → batch import from session transcript
5. **Convention detection:** `detect-conventions` → AST analysis → store conventions with confidence

---

## Data Model

### Core Tables

```sql
-- The source of truth. Markdown files are a derived export.
entries (
  id TEXT PRIMARY KEY,          -- UUID
  type TEXT NOT NULL,           -- convention | error_pattern | decision | learning | ghost_knowledge
  title TEXT NOT NULL,
  content TEXT NOT NULL,        -- Markdown body
  status TEXT DEFAULT 'active', -- active | archived | superseded
  scope TEXT DEFAULT 'personal',-- personal | team
  confidence REAL DEFAULT 0.5, -- [0.0, 1.0]
  source_count INTEGER DEFAULT 1,
  fingerprint TEXT,             -- SHA-256 for dedup
  metadata TEXT,                -- JSON blob (entities, etc.)
  markdown_path TEXT,           -- Derived export path in gyst-wiki/
  created_at TEXT,
  last_confirmed TEXT,
  updated_at TEXT
)

entry_files (entry_id, file_path)     -- Which files an entry references
entry_tags (entry_id, tag)            -- Searchable tags
relationships (                        -- Directed edges between entries
  source_id, target_id, type,         -- related_to | similar_to | supersedes | co_retrieved
  weight REAL                          -- Edge strength [0,1]
)
sources (entry_id, author, tool, created_at)  -- Provenance chain
entries_fts (title, content, tags)            -- FTS5 with porter stemmer

-- Structural graph (from Graphify AST analysis, not curated)
structural_nodes (id, kind, name, file_path, start_line, end_line)
structural_edges (source_id, target_id, relation)
```

### Entry Types

| Type | What it captures | Decay half-life | Example |
|------|-----------------|-----------------|---------|
| `convention` | Team coding standards | Never (stable) | "We use camelCase for function names" |
| `error_pattern` | Known failure modes with signatures | 30 days | "TS2322: Type 'string \| undefined' not assignable to 'string'" |
| `decision` | Architectural choices with rationale | 365 days | "Chose Bun over Node for native SQLite" |
| `learning` | Concrete insights grounded in code | 60 days | "bun:sqlite prepared statements don't autofinalize" |
| `ghost_knowledge` | Tribal rules not in any doc | Never | "Don't touch the auth middleware — it's wired to compliance" |

### Why 5 types, not more

We tried finer-grained taxonomies (10+ types). They made the classifier brittle and forced users to understand the type system. Five types hit the sweet spot: each maps to a distinct retrieval strategy and decay profile, the classifier can distinguish them with simple regex rules, and users intuit the difference without training.

The closest competitor (ByteRover) uses zero types — pure hierarchy (Domain → Topic → Subtopic → Entry). Their approach scales better to large corpora but makes retrieval less precise: you can't ask "show me all error patterns" or apply type-specific decay.

---

## Knowledge Ingestion Pipeline

```
Raw input (learn tool / git hook / harvest)
    │
    ▼
┌─────────────┐
│   Extract    │ → Validate with Zod, extract entities (regex-based),
│              │   generate fingerprint hash
└──────┬──────┘
       ▼
┌─────────────┐
│  Normalize   │ → Error signatures: replace paths, UUIDs, timestamps,
│              │   URLs, quoted strings, numbers → stable tokens
└──────┬──────┘
       ▼
┌─────────────┐
│ Deduplicate  │ → Fingerprint match (exact) + Jaccard similarity on
│              │   tags/files (fuzzy). Merge if overlap > threshold.
└──────┬──────┘
       ▼
┌─────────────┐
│    Link      │ → Discover relationships via shared files, tags,
│              │   error types. Create edges in relationship graph.
└──────┬──────┘
       ▼
┌─────────────┐
│   Write      │ → Insert to SQLite within transaction.
│              │   Optionally export to markdown (gyst-wiki/).
└─────────────┘
```

### Entity Extraction

Lightweight regex-based, not NER. Extracts:
- File paths (`src/auth/middleware.ts`)
- Function/class names (camelCase, PascalCase, snake_case identifiers)
- Error codes (`TS2322`, `ENOENT`)
- Package names (`@modelcontextprotocol/sdk`)

We rejected spaCy/Hugging Face NER models because they add 500MB+ dependencies for marginal accuracy gain on code-specific entities. Regex catches 90%+ of what matters in developer text.

### Error Normalization

Seven-step pipeline, order matters:

1. Replace file paths with `<PATH>`
2. Replace line:col references with `<LINE>`
3. Replace UUIDs with `<UUID>`
4. Replace timestamps with `<TS>`
5. Replace URLs with `<URL>`
6. Replace quoted strings with `<STR>`
7. Replace numbers with `<N>` (LAST — prevents clobbering UUIDs/timestamps)

The normalized signature gets SHA-256 hashed into a fingerprint for exact-match deduplication.

---

## Search & Retrieval

Five strategies run in parallel, fused with **Reciprocal Rank Fusion** (k=60):

| # | Strategy | What it does | When it dominates |
|---|----------|-------------|-------------------|
| 1 | File path lookup | Exact match on `entry_files` | "What do we know about auth/middleware.ts?" |
| 2 | BM25 via FTS5 | Keyword search with porter stemmer + query expansion | Natural language questions |
| 3 | Graph traversal | Walk `relationships` from known entities | "What's related to the TOTP decision?" |
| 4 | Temporal | Recency-weighted results | "What happened last week?" |
| 5 | Vector (semantic) | MiniLM-L6-v2 embeddings via sqlite-vec | Conceptual similarity across vocabulary gaps |

### Why RRF, not learned re-ranking

Reciprocal Rank Fusion is parameter-free (just k=60), deterministic, and doesn't need training data. Learned re-rankers (cross-encoders, LambdaMART) need labelled relevance judgments we don't have at scale. RRF performs within 2-3% of trained fusion on our benchmarks at zero cost.

### Query Expansion

BM25 queries get synonym expansion before hitting FTS5. Example: `authentication` → `authentication auth login session`. Implemented as a static synonym map + code tokenization (camelCase/snake_case splitting).

### Ghost Knowledge Boost

Ghost knowledge entries (tribal rules) get a **+0.15 RRF boost** and always surface in tier 0 of recall results. Rationale: ghost knowledge is the most valuable and rarest signal — it exists nowhere else in the codebase. Under-surfacing it defeats the purpose.

### Co-Retrieval

After every search, we record which entries appeared together in results. When two entries co-appear 3+ times, the consolidation pipeline auto-creates a `co_retrieved` relationship edge. This strengthens the graph over time without manual linking.

### Context Budgeting

The `recall` tool accepts a `context_budget` parameter (default: 5000 tokens). Results are formatted in 4 tiers of decreasing detail until they fit:
1. Full markdown content
2. Title + first paragraph + metadata
3. Title + one-line summary
4. Title only

This ensures recall responses never blow the agent's context window.

---

## Confidence & Decay

Every entry has a confidence score ∈ [0.0, 1.0] that determines whether it surfaces in search results.

### Scoring Formula

```
confidence = base_confidence
  × source_saturation(source_count)
  × time_decay(type, last_confirmed)
  × (1 - contradiction_penalty)
  × (1 - code_change_penalty)
```

### Type-Specific Half-Lives

| Type | Half-Life | Rationale |
|------|-----------|-----------|
| convention | ∞ (no decay) | Coding standards are stable until explicitly changed |
| error_pattern | 30 days | Errors get fixed; stale patterns are noise |
| decision | 365 days | Architectural choices are durable but eventually revisited |
| learning | 60 days | Insights are useful short-term; the important ones get re-confirmed |
| ghost_knowledge | ∞ (no decay) | Tribal rules outlive individuals |

### Feedback Loop

The `feedback` MCP tool lets agents rate entries:
- **Helpful (+1):** Confidence += 0.02
- **Unhelpful (-1):** Confidence -= 0.05

The asymmetric adjustment (2% up, 5% down) means negative signal is stronger — one bad result demotes faster than one good result promotes. This prevents confidence inflation.

### Archival

Entries below 0.15 confidence are excluded from recall results. They remain in SQLite (never deleted) for audit trails and potential revival if re-confirmed.

---

## Classifier Pipeline

Three-stage pipeline for deciding whether a developer event should become a curated knowledge entry:

```
Raw Event (prompt / tool_use / commit / md_change / plan_added)
    │
    ▼
┌─────────────────┐
│  Stage 1: Rules  │ Pure regex/heuristic. Emits signalStrength [0,1],
│  (classify-event) │ scopeHint, candidateType, ruleIds.
└───────┬─────────┘
        ▼
┌─────────────────┐
│  Stage 2: Rerank │ Graph-based demotion. If the entry already exists
│  (graphify)      │ or overlaps heavily with known entries, dampen signal.
└───────┬─────────┘
        ▼
┌─────────────────┐
│  Stage 3: Distill│ LLM pass via Claude Haiku. Only fires for borderline
│  (LLM, optional) │ verdicts (0.4 < signal < 0.7). Budget-capped.
└─────────────────┘
```

### Stage 1: Rules (classify-event.ts)

Pattern arrays for each signal type:
- **TEAM_SIGNAL_PATTERNS:** "we always", "we use", "we decided", "must not" → team scope
- **CONVENTION_PATTERNS:** camelCase mentions, "naming convention", "always use" → convention
- **DECISION_PATTERNS:** "we decided", "because", "rationale" → decision
- **ERROR_TOKENS:** "error", "exception", "failed", "ENOENT" → error_pattern

**Reject filters** (added April 2026, take precedence over all positive signals):
- **QUESTION_PATTERNS:** Trailing `?`, interrogative + "we" opening → null
- **HISTORICAL_PATTERNS:** "we used to", "we stopped", "anymore", "back when" → null
- **SOFT_QUALIFIER_PATTERNS:** "sometimes", "usually", "not a rule", "it varies" → null

These reject filters solved a critical bloat problem: questions like "should we use camelCase?" were being promoted as conventions because they triggered both TEAM_SIGNAL and CONVENTION patterns.

### Stage 2: Graphify Rerank (classify-rerank.ts)

Queries the existing knowledge base for overlap:
- Entity overlap (shared function names, file paths)
- Title Jaccard similarity
- File path intersection

High overlap → demote signal (the knowledge is already captured). Novel entries get a slight boost via `graph-novel` rule ID.

### Stage 3: LLM Distill (classify-distill.ts)

Only fires when:
1. Signal strength is in the borderline zone (0.4–0.7)
2. Budget permits (capped per batch, default 200 calls/run)
3. `ANTHROPIC_API_KEY` is set

Uses Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) with temperature 0. The LLM either confirms or overrides the rules verdict, with a one-line `reasoning` field for auditability.

### Why not LLM-first

We considered making the LLM the primary classifier (skip rules entirely). Rejected because:
1. **Cost:** Even Haiku at $0.25/1M input tokens adds up across hundreds of events per session.
2. **Latency:** 200-400ms per LLM call vs. <1ms for regex rules.
3. **Determinism:** Rules produce identical results for identical inputs; LLMs don't.
4. **Debuggability:** `ruleIds` array on every verdict makes it trivial to trace why something was classified a certain way.

The three-stage design gives us rules for speed/cost, graph for dedup, and LLM for the hard cases — each stage handles what it's best at.

### Eval Results (April 2026)

On the 30-row adversarial fixture:
- **Accuracy:** 80.0%
- **Bloat score:** -0.133 (negative = under-promoting, safe direction)
- **Convention precision:** 100% (was 33% before reject filters)
- **Decision precision:** 66.7%
- **Error_pattern precision:** 100%

---

## Consolidation Engine

Multi-stage batch pipeline that runs periodically (on session end or manual trigger):

```
Stage 1: Deduplication
  → Fingerprint match (exact) + Jaccard similarity (fuzzy)
  → Merge duplicates, combine sources, keep highest confidence

Stage 2: Linking
  → Discover new relationships via shared files/tags/types
  → Strengthen existing edges based on co-retrieval data

Stage 2.5: Co-retrieval Promotion
  → Entries that appeared together 3+ times in search results
  → Auto-create "co_retrieved" relationship edges

Stage 3: Convention Consolidation
  → Conventions detected in 3+ directories → promote to PROJECT_WIDE
  → Keyed on category::pattern (not directory)
  → Average confidence across instances; reject if below 0.6
```

### Why per-pattern keying

Early consolidation grouped by `directory`. This collapsed distinct patterns that happened to appear in the same directory into one entry. Keying on `category::pattern` means "use-camelCase" and "prefer-const" in the same directory stay separate.

---

## MCP Tools

The surface is organized around three unified verbs — `read`, `check`, `admin` — plus write-side and specialized tools. Legacy single-purpose tools (`recall`, `search`, `get_entry`, `check_conventions`, `failures`, `activity`, `status`) remain registered for backward compat and prepend a deprecation notice to their responses.

### Core surface

| Tool | Purpose | Actions |
|------|---------|---------|
| `read` | Read team knowledge | `recall` (default, ranked full-content) · `search` (compact index) · `get_entry` (by id) |
| `check` | Check code/errors against team knowledge | `violations` (default, scan a file) · `conventions` (rules for a path) · `failures` (known-error lookup) |
| `admin` | Team observability | `activity` (default, recent events) · `status` (who's active right now) |
| `learn` | Record team knowledge | Entity extraction, auto-linking, dedup |
| `feedback` | Rate an entry | +0.02 (helpful) / -0.05 (unhelpful) confidence adjustment |
| `harvest` | Batch import | Extract knowledge from session transcript |
| `conventions` | List coding standards | Filter by directory/tags, confidence-sorted |
| `graph` | Explore relationships | Neighbors, path between entries, similar entries |
| `configure` | Adjust server configuration at runtime | — |

### Deprecated legacy tools

| Old tool | Replacement |
|----------|-------------|
| `recall` | `read({ action: "recall", query })` |
| `search` | `read({ action: "search", query })` |
| `get_entry` | `read({ action: "get_entry", id })` |
| `check_conventions` | `check({ action: "conventions", file_path })` |
| `failures` | `check({ action: "failures", error_message })` |
| `activity` | `admin({ action: "activity" })` |
| `status` | `admin({ action: "status" })` |

### Tool Design Principles

1. **Stateless request/response.** No tool holds a cursor or session. Every call is self-contained.
2. **Token-budgeted.** `recall` and `harvest` respect context budget parameters. Never blow the agent's context window.
3. **Fail-soft.** Every tool returns a valid response even on internal errors. Agents should never crash because Gyst is down.
4. **Audit-trailed.** Every `learn` and `feedback` call records provenance (who, when, which tool).

---

## CLI

```
gyst setup              — Detect conventions from a sample project
gyst install            — Auto-detect AI tools, write MCP config
gyst detect-conventions — Run convention detectors, print results
gyst check <file>       — Check a file for convention violations
gyst search <query>     — Search knowledge base
gyst recall <query>     — Ranked recall with context budgeting
gyst recap              — Generate session recap
gyst export             — Export all entries to gyst-wiki/ markdown
gyst ghost-init         — Create ghost knowledge entries interactively
gyst onboard            — Generate onboarding document for new devs
gyst harvest            — Batch import from session transcript
gyst team-init          — Initialize team mode
gyst dashboard          — Start the dashboard HTTP server
```

### Install Flow

`gyst install` auto-detects installed AI coding tools and writes MCP configuration:
- **Claude Code:** `.claude.json` → `mcpServers.gyst`
- **Cursor:** `.cursor/mcp.json`
- **Codex CLI:** `.codex/mcp.json`
- **Gemini CLI:** `.gemini/settings.json`
- **Continue:** `.continue/config.json`
- **Windsurf:** `.windsurf/mcp.json`

All use stdio transport pointing at `dist/server.js`.

---

## Dashboard

React 18 + Vite + Tailwind SPA at `http://localhost:3579` served by `gyst dashboard`.

### Architecture

- **Frontend:** React 18 + Vite + TypeScript + Tailwind, built to `src/dashboard/dist/`
- **Server:** `src/dashboard/server.ts` serves `dist/` as static files; all routes except `/api/*` and `/legacy` serve `dist/index.html` (SPA routing)
- **`gyst dashboard`** starts the server on port 3579 and opens the browser
- **Build:** `npm run build:dashboard` from project root, or `cd src/dashboard/ui && npm run build`
- **Legacy D3 graph** preserved at `/legacy` for structural (Graphify) visualization

### Frontend Components

| Component | Purpose |
|-----------|---------|
| `Masthead` | Black header bar — publication date, 52px serif "Gyst" wordmark, Capture + Invite buttons |
| `ModeRail` | Team/Personal tabs with entry counts + inline search |
| `Feed` | Chronological entry list with type-filter chips and confidence bars |
| `EntryCard` | Individual entry with serif title, type badge, confidence bar |
| `Sidebar` | Review Queue card, Team Pulse stats (2×2 grid), Team Members list |
| `CaptureModal` | 5-type picker grid, Personal/Team scope segmented control, ⌘N shortcut |
| `InviteModal` | 3-step onboarding: install command → detected tools grid → invite link; ⌘I shortcut |
| `EntryDrawer` | Slides in from right — full content in serif, feedback/promote/edit actions |

### API Endpoints

All endpoints are local-only with no authentication required.

| Endpoint | Returns |
|----------|---------|
| `GET /api/entries` | Paginated entries (scope, type, limit, offset params) |
| `GET /api/entries/:id` | Single entry + relationships + sources |
| `GET /api/search?q=&scope=` | BM25 search results |
| `GET /api/team/members` | Registered team members |
| `GET /api/team/info` | Team metadata |
| `GET /api/health` | Server health check |
| `GET /api/tools/detected` | AI tools detected on this machine |
| `POST /api/entries` | Create a new entry |
| `PATCH /api/entries/:id` | Update an entry |
| `POST /api/entries/:id/feedback` | Submit helpful/unhelpful rating |
| `POST /api/entries/:id/promote` | Promote entry scope |
| `POST /api/team/invite` | Generate invite key |
| `POST /api/team/invite/email` | Send invite via email |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘K | Focus search |
| ⌘N | Open Capture modal |
| ⌘I | Open Invite modal |
| Esc | Dismiss modal / close drawer |

### Design System

Paper/ink editorial aesthetic: Fraunces (serif headings), Inter Tight (sans UI), JetBrains Mono (code/metadata). Warm `#F5F1E8` paper background, black masthead.

---

## Plugin System

```
plugin/
  .claude-plugin/         — Claude Code marketplace metadata
  .codex-plugin/          — Codex CLI plugin metadata
  hooks/hooks.json        — Hook configuration (pre-commit, post-commit, post-merge)
  scripts/
    session-start.js      — Session start hook → inject context
    session-end.js         — Session end hook → harvest + consolidate
    prompt.js              — Prompt hook → enrich with recall context
    tool-use.js            — Tool use hook → capture errors
    postinstall.mjs        — Post-npm-install setup
```

### Hook Architecture

Hooks fire shell commands in response to events:
- **session-start:** Injects team conventions + recent failures into the agent's context
- **session-end:** Harvests the session transcript for knowledge, runs consolidation
- **prompt:** Enriches the prompt context with relevant recalls
- **tool-use:** Captures error events from tool invocations
- **pre-commit:** Optional convention check before committing
- **post-commit:** Captures significant commits into the knowledge base
- **post-merge:** Handles merge-specific knowledge capture

---

## Capture Layer

The capture layer is where data enters the knowledge base. Two fundamentally different entry paths feed the same SQLite store, and they must not be conflated.

### Entry paths — agent-triggered vs harness-triggered

```
┌─────────────────────────┐        ┌────────────────────────────┐
│ Model (inside agent)    │        │ Harness (Claude Code, etc.)│
│                         │        │                            │
│ decides to call a tool  │        │ fires on lifecycle events  │
│  learn / recall / check │        │  SessionStart, PreCompact, │
│                         │        │  SessionEnd, PostToolUse   │
└───────────┬─────────────┘        └──────────────┬─────────────┘
            │ MCP call                            │ shell exec
            ▼                                     ▼
  ┌────────────────────┐               ┌─────────────────────────┐
  │ MCP server handler │               │ Gyst CLI command        │
  │ (src/mcp/tools/*)  │               │ (gyst inject-context,   │
  │                    │               │  gyst harvest, …)       │
  └──────────┬─────────┘               └──────────────┬──────────┘
             │                                        │
             └───────────────────┬────────────────────┘
                                 ▼
                         .gyst/wiki.db (SQLite)
```

Two properties matter:

- **MCP calls are probabilistic** — they fire only if the model chooses a tool. Useful for *reactive* capture (the agent noticed something worth saving).
- **Hooks are deterministic** — the harness fires them on every matching event, regardless of model behavior. Useful for *passive* capture (inject context at session start, harvest transcript before compaction).

Because both paths write to the same tables through the same compiler pipeline (`extract → normalize → deduplicate → link → write`), entries are indistinguishable once stored. The `source` column on `events` records which path originated the write for debugging.

### Git Hooks (git-hook.ts)

Post-commit hook captures:
- AI-authored commits (detected by Co-Authored-By trailers)
- Commits touching 5+ files (likely architectural)
- Commits with conventional commit types (`feat`, `fix`, `refactor`)
- Merge commits with conflict resolution

### Session Injection (session-inject.ts)

On session start, injects into agent context:
- Active conventions relevant to current branch/directory
- Recent error patterns that match open files
- Ghost knowledge for the current project
- Team activity summary (if team mode)

### Manual Entry (manual.ts)

CLI-driven entry creation with interactive prompts for type, scope, content.

---

## Security

### What we strip (security.ts)

`stripSensitiveData()` runs on ALL content before storage:
- API keys (sk-*, xoxb-*, ghp_*, etc.)
- Connection strings (postgres://, mongodb://, redis://)
- JWT tokens
- Environment variable values
- SSH private keys
- AWS credentials
- Passwords in config files

### What we don't strip

- File system paths (home directory paths may leak through `cwd` fields — requires manual scrub)
- Developer names (stored for attribution, considered acceptable PII)
- Repository URLs (considered public information)

### Architectural boundary

The MCP server is the ONLY interface to the knowledge base. No direct SQLite access from agents. All reads go through `recall`/`search`/`get_entry`; all writes go through `learn`/`harvest`. This centralizes security enforcement.

---

## Benchmarks

### LongMemEval-S (500 questions, 23,867 documents)

| Metric | Gyst | ByteRover | Delta |
|--------|------|-----------|-------|
| Hit Rate @5 | 94.2% | 92.8% | +1.4% |
| MRR @5 | 83.7% | — | — |
| Recall @5 | 86.8% | — | — |

### CodeMemBench (200 queries, code-memory-specific)

| Metric | Score |
|--------|-------|
| NDCG @10 | 0.351 |
| Recall @10 | 0.677 |
| MRR @10 | 0.274 |
| Hit Rate @10 | 78% |
| Ghost Knowledge Hit | 92% |
| Convention Hit | 64% |
| Onboarding Hit | 84% |

### CodeMemBench Ablation (strategy contribution)

| Removed Strategy | NDCG @10 | Hit Rate | Impact |
|-----------------|----------|----------|--------|
| Baseline (all) | 0.351 | 78% | — |
| No semantic | 0.043 | 10% | **-87.8%** (catastrophic) |
| No file_path | 0.336 | 76% | -4.2% |
| No BM25 | 0.351 | 78% | 0% (redundant with semantic) |
| No graph | 0.351 | 78% | 0% (redundant) |
| No temporal | 0.351 | 78% | 0% (not triggered) |

**Key finding:** Semantic search (sqlite-vec + MiniLM-L6-v2) is the dominant strategy. Without it, hit rate drops from 78% to 10%. BM25 and graph are safety nets for vocabulary-mismatch cases where embeddings fail.

### CoIR (4 code-retrieval subtasks)

| Task | NDCG @10 | Recall @10 |
|------|----------|------------|
| stackoverflow-qa | 0.840 | 0.926 |
| codefeedback-st | 0.660 | 0.817 |
| codefeedback-mt | 0.356 | 0.468 |
| cosqa | 0.327 | 0.564 |
| **Mean** | **0.546** | **0.694** |

### Classifier Eval (30-row adversarial fixture)

| Metric | Before filters | After filters |
|--------|----------------|---------------|
| Accuracy | 66.7% | 80.0% |
| Bloat score | 0.000 | -0.133 |
| Convention precision | 33.3% | 100.0% |
| Decision precision | 50.0% | 66.7% |

---

## Competitive Landscape

Research conducted April 2026 across four competitors:

### ByteRover

**What they do:** User-invoked curation pipeline → 3-phase LLM (preprocess → compact → 5-op agent: ADD/UPDATE/UPSERT/MERGE/DELETE). Hierarchical context tree (Domain → Topic → Subtopic → Entry). Adaptive Knowledge Lifecycle with importance score ι∈[0,100], 3 maturity tiers (Draft → Validated → Core), recency decay.

**How they eval:** LLM-as-judge (Gemini 3 Flash judge + Pro justifier, T=0). 92.8% LongMemEval-S, 96.1% LoCoMo.

**What Gyst does differently:** Typed taxonomy (5 types vs. none), automatic capture from git/sessions (vs. user-invoked only), deterministic classifier with rule IDs (vs. LLM-primary), ghost knowledge tier.

**Source:** CLI is Elastic License 2.0 (github.com/campfirein/byterover-cli). Paper: arXiv:2604.01599.

### Packmind

**What they do:** Human-authored playbooks (`.packmind/standards/*.md`) → multi-agent file renderer that distributes rules to Claude Code, Cursor, Copilot via tool-specific config files (.claude/rules/, .cursor/rules/, AGENTS.md). Enterprise linter: LLM synthesizes deterministic detection programs per rule, validated against positive/negative code examples.

**What Gyst does differently:** Automatic knowledge extraction (vs. human-authored only), runtime MCP retrieval with ranking (vs. static file rendering), confidence decay, benchmarks.

**Source:** MIT (github.com/PackmindHub/packmind).

### Sourcegraph Cody

**What they do:** Stateless code retrieval via keyword index (symf/Bluge) + Sourcegraph server search. Author-written `.sourcegraph/*.rule.md` files. No memory layer, no learning, no persistence across requests.

**What Gyst does differently:** Everything about persistence — Cody re-retrieves from scratch every request. No extracted knowledge, no confidence, no team memory. Cody is a code search tool, not a knowledge layer.

**Source:** Open-source (github.com/sourcegraph/cody).

### Qodo (formerly CodiumAI)

**What they do:** Multi-repo code indexing with language-specific static analysis. "Auto Best Practices": analyzes accepted PR review suggestions → writes `.pr_agent_auto_best_practices` file. Discovered vs. learned practice distinction.

**What Gyst does differently:** Richer taxonomy (5 types vs. discovered/learned), MCP-native (vs. PR-review-only), works across all AI tools (vs. Qodo Merge only), public benchmarks.

**Source:** pr-agent is open-core (github.com/Codium-ai/pr-agent). Context engine is proprietary.

### Summary Matrix

| Capability | Gyst | ByteRover | Packmind | Cody | Qodo |
|-----------|------|-----------|----------|------|------|
| Auto-capture from sessions | Yes | No (user-invoked) | No (human-authored) | No | Partial (PR only) |
| Typed taxonomy | 5 types | None (hierarchy) | None (flat rules) | None | 2 types |
| Confidence decay | Yes (type-specific) | Yes (importance ι) | No | No | No |
| Multi-tool support | 7 tools | 4 tools | 6 tools | 1 (Cody) | 1 (Qodo Merge) |
| Public benchmarks | 3 (LME, CMB, CoIR) | 2 (LME, LoCoMo) | 0 | 0 | 0 |
| Ghost knowledge | Yes | No | No | No | No |
| Knowledge graph | Yes | No | No | Yes (code graph) | No |
| MCP native | Yes | No | Partial | No | No |
| Open source | MIT | ELv2 | MIT | OSS | Open-core |

---

## Decision Log

All architectural decisions are recorded in `decisions/`:

| ADR | Decision | Key tradeoff |
|-----|----------|-------------|
| 001 | Add synonym query expansion to BM25 | Recall vs. precision — synonyms improve recall at slight precision cost |
| 002 | Add temporal search strategy | Recency weighting for debugging-intent queries |
| 003 | Adaptive recall formatting via context_budget | Never blow the agent's context window; 4-tier fallback |
| 004 | Lightweight regex entity extraction | Speed vs. accuracy — regex catches 90%+ of code entities without NER model |
| 005 | Multi-upgrade integration review | Validation of parallel-worker pattern for bulk upgrades |
| 006 | Semantic search via sqlite-vec + MiniLM-L6-v2 | Zero external dependencies vs. hosted vector DB; sqlite-vec runs in-process |
| 007 | Ghost knowledge as first-class entry type | Captures tribal rules that exist nowhere in code/docs; +0.15 RRF boost |
| 008 | Consolidation pipeline architecture | Multi-stage batch (dedup → link → co-retrieval → convention consolidation) |
| 009 | Session harvesting via PreCompact hook | Capture knowledge before context window compaction discards it |
| 010 | LongMemEval public benchmark baseline | Standardized evaluation against academic memory benchmarks |
| 011 | CoIR + CodeMemBench dual benchmark | Code-specific retrieval evaluation covering both generic and memory-specific tasks |
| 012 | Bun test-runner teardown crash workaround | @huggingface/transformers ONNX runtime crashes Bun's process teardown; isolated with try/catch |
| 013 | Prompt-level classifier: three-stage pipeline | Rules → graph rerank → LLM distill; deterministic first, LLM only for borderline |

---

## Completed Edits

This section is the changelog for items originally listed under **Future Edits** that have now shipped. When you finish an item, move its tracker checkbox to ticked and add a one-line entry here with the date and the affected files / commands so a future reader can see what "done" meant in practice.

| Date | Item | What changed | Pointer |
|---|---|---|---|
| 2026-04-18 | **§1 Project Root Awareness (CLI)** | `findProjectRoot()` walks up for `.gyst/`; `loadConfig()` refuses outside a project via `NoProjectError`; new `gyst projects` command lists roots + orphans; `install` (both interactive and `--minimal`) warns / refuses on nested projects with `GYST_FORCE_NESTED=1` escape hatch. | [src/utils/config.ts](src/utils/config.ts), [src/utils/errors.ts](src/utils/errors.ts), [src/cli/index.ts](src/cli/index.ts), [src/cli/install.ts](src/cli/install.ts), [tests/cli/install.test.ts](tests/cli/install.test.ts) |
| 2026-04-18 | **Bonus — Bun-on-Windows DB fix** | `initDatabase()` no longer calls `mkdirSync(".", { recursive: true })` (Bun-on-Windows throws `EEXIST`). Drops Windows test failures from 274 → 5. | [src/store/database.ts](src/store/database.ts) |
| 2026-04-19 | **§4 Scope trap — flip CLI-add default to `team`** | `addManualEntry` now defaults to `"team"` scope when no scope is set; `gyst add` gains `-s/--scope` with `team` as the default and echoes the chosen scope back. MCP `learn` path unchanged (keeps per-type defaulting). | [src/capture/manual.ts](src/capture/manual.ts), [src/cli/index.ts](src/cli/index.ts) |
| 2026-04-19 | **§4 `gyst list`** | New browse command with `--type / --tag / --scope / --limit` filters. Returns an `active`-only table of confidence · type · scope · title · id ordered by `last_confirmed` DESC. | [src/cli/index.ts](src/cli/index.ts) |
| 2026-04-19 | **§4 PATH-detection banner** | CLI scans `$PATH` on startup; if `gyst` isn't resolvable, prints a one-line stderr banner with the actual invocation path and a `GYST_SUPPRESS_PATH_BANNER=1` opt-out. Runs in both `gyst` and `gyst-mcp`/`bunx` paths. | [src/cli/index.ts](src/cli/index.ts) |
| 2026-04-19 | **§7c Positioning rewrite** | ARCHITECTURE.md "What Gyst Is" one-liner moves from "persistent, shared memory" to "team knowledge layer — open, self-hosted, tool-agnostic." README gains an anti-Anthropic subhead and a "Why not Claude memory / Mem0 / Cursor rules?" comparison table. | [ARCHITECTURE.md](ARCHITECTURE.md), [README.md](README.md) |

> **MCP-side still pending for §1**: the live MCP server used by agents resolves `bunx gyst-mcp`, which pulls the published npm package. The fix is in local `dist/` after `bun run build`, but to make it live for everyone we need to republish `gyst-mcp` (or point `.mcp.json` at the source). Tracked in the Future Edits progress tracker below.

---

## Future Edits

This section is the team's honest notebook of **known problems, missing features, and product-level gaps** — along with how we'd fix each one. Each entry is written for two audiences at once:

- **A beginner** can read the "In plain English" and "Why this matters" parts and understand the problem without any technical background.
- **A contributor or engineer** can read the "How to implement" details and start writing code.

Think of this section as the difference between "we know we're behind" (a confession) and "we know we're behind, here's the plan, here's how we'll know we succeeded" (a roadmap).

### Progress Tracker

Tick the box when a line item ships. When every sub-item under a top-level number is ticked, copy the whole section's one-line summary into the **Completed Edits** table above and leave the detailed prose here as historical spec.

**§1 — Project Root Awareness**
- [x] `findProjectRoot()` helper in `src/utils/config.ts`
- [x] Route `loadConfig()` through the helper; refuse outside a project via `NoProjectError`
- [x] Friendly refusal on `add` / `recall` / `check` / `dashboard`
- [x] `gyst projects` command to list roots + orphans
- [x] Install refuses to create nested projects silently (interactive + `--minimal` paths)
- [ ] **Republish** `gyst-mcp` so the live MCP server picks up the walk-up behaviour (local `dist/` already rebuilt)

**§2 — Historical Backfill**
- [ ] `gyst backfill [--since] [--max]` CLI command reusing `captureCommit()`
- [ ] `--author` / `--paths` filters
- [ ] Progress indicator (one line per 50 commits)
- [ ] Idempotent via existing dedupe

**§3 — Install-Time Privacy Prompt**
- [ ] Scope-selection prompt in `gyst install` (skipped under `--minimal`)
- [ ] Path 1 (local only) — auto-add `gyst-wiki/` to project `.gitignore`
- [ ] Path 2 (private wiki repo) — prompt for sibling repo path, configure `wikiDir`
- [ ] Path 3 (HTTP server) — wire Bearer MCP config, skip local wiki writes
- [ ] `gyst privacy` CLI to switch modes post-install

**§4 — Related Smaller Gaps**
- [x] Flip default scope from `personal` to `team` (or prompt once on first `gyst add`)
- [x] `gyst list [--type] [--tag] [--limit]` browse command
- [x] PATH detection banner when `gyst` isn't resolvable
- [ ] Windows SQLite probe paths + bundled `sqlite-vec` DLL (see §5 Windows for full plan)
- [ ] Resolve `wikiDir` relative to project root (covered by §1 — re-verify)

**§5 — Strategic Gaps vs Commercial Alternatives**
- [ ] **Setup Friction** — `.exe`/`.pkg` installer bundling Bun; zero-config mode
- [ ] **UX Immaturity** — `gyst doctor` self-check; human-readable recall output
- [ ] **Windows Degraded** — probe paths + bundled DLL + `windows-latest` CI
- [ ] **No Ecosystem** — template library (`gyst template apply <stack>`); public demo site
- [ ] **Marketing Asymmetry** — YC launch post, HN/PH coordinated launch, benchmark-number microsite, 5-team design-partner programme

**§6 — Necessary-Maker Improvements**
- [ ] 6a. Ambient capture (`gyst watch` + dashboard review queue)
- [ ] 6b. Historical import from past Claude/Cursor sessions (`gyst import --from <tool>`)
- [ ] 6c. Weekly impact report (`gyst recap --weekly` + dashboard panel + email digest)
- [ ] 6d. Pick one killer use-case wedge (initial recommendation: **onboarding killer**)

**§7 — Structural Moats vs Model Vendors**
- [ ] 7a. `SPEC.md` v0.1 + conformance test suite; CC-BY-4.0 docs licence
- [ ] 7b. Non-chat capture sources — PR review comments, error-tracker ingest, ticket-tracker ingest
- [x] 7c. Kill personal-memory framing in README / ARCHITECTURE.md one-liners
- [ ] 7d. Consolidate 14 MCP tools → 7–8 with richer parameters

---

### 1. Project Root Awareness — "Which knowledge base am I using?"

**Status:** ✅ CLI shipped 2026-04-18 · ⏳ MCP server awaiting republish of `gyst-mcp`

**In plain English**

Today, Gyst creates a brand-new knowledge base in whatever folder you happen to be standing in when you run a command. If you accidentally run it from the wrong folder, you end up with multiple disconnected knowledge bases and can't find your own entries.

**Real-world analogy**

It's like Microsoft Word saving every document to whichever folder your cursor was in when you opened it — instead of remembering which project you're working on. You'd end up with the same file in five different places and never know which is current.

**The technical problem**

The CLI currently creates or uses a `.gyst/wiki.db` in whatever directory it's invoked from. There's no concept of a "project root." A user who runs `gyst add` from a parent folder silently creates a second knowledge base; a subsequent `gyst recall` from the project subfolder can't see those entries. No warning is printed.

**How it should work (the git comparison)**

Git (the tool developers use to track code changes) gets this right. Each project has a hidden `.git/` folder at its root. When you run any git command, git walks up the folder tree looking for that `.git/` folder. If it finds one, it uses it. If not, it says "this isn't a git project."

Gyst should behave the same way — walk up looking for `.gyst/`, and complain if none exists.

```
Correct behaviour:
  cd into a project with .gyst/ at root     → act on root's database
  cd into a subfolder of that project       → still act on root's database
  cd into a folder outside any project      → refuse, prompt `gyst install`

Current broken behaviour:
  cd into yc/gyst/    → gyst uses yc/gyst/.gyst/wiki.db   ← correct
  cd into yc/         → gyst creates a NEW .gyst here     ← the bug
```

**Why this matters**

1. Users save entries from the "wrong" folder, can't find them later, and assume Gyst is broken.
2. Orphan databases pile up silently; no command lists them.
3. New users abandon the tool inside their first session because nothing they save stays findable.

**How to implement**

1. Add `findProjectRoot(startDir)` in `src/utils/config.ts`:
   - Walk parent directories from `startDir` upward.
   - Return the first directory containing `.gyst/wiki.db`.
   - Return `null` if filesystem root is reached without finding one.
2. Route every CLI entry point's DB path through this helper instead of `process.cwd()`.
3. Behaviour when `findProjectRoot` returns `null`:
   - `add`, `recall`, `check`, `dashboard` — error with `"no gyst project found; run 'gyst install' to initialise one"`.
   - `install` — proceed (this is the initialisation step).
4. Add `gyst projects` command to list all `.gyst/` folders under a given path, so users can find orphan DBs.

**Multi-project behaviour to preserve**

Each project should keep its own independent knowledge base. Conventions, bugs, and decisions are project-scoped because:

- Conventions differ per codebase.
- Error patterns reference project-specific files.
- Architectural decisions relate to a specific code structure.

Cross-project knowledge sharing is the job of the team HTTP server (`gyst serve`), not something local databases should merge on their own. A `my-webapp/` project initialised later should create its own `.gyst/wiki.db` independent of this one.

---

### 2. Historical Backfill — "What about my repo's past?"

**Status:** ⏳ Not started

**In plain English**

When you install Gyst today, it starts capturing knowledge from your **next commit forward**. Every commit before today — years of bug fixes, decisions, lessons — is invisible. Gyst feels empty on day one even though your repo has been collecting wisdom for years.

**Real-world analogy**

Imagine moving into a house where the previous owner left ten years of photo albums in the attic. Family history, memories, context about who lived there — all there, all valuable. But you never look in the attic, so none of it exists to you.

Today's Gyst ignores the attic.

**The technical problem**

The post-commit hook captures every future commit after `gyst install`, but nothing scans the repo's existing git history. Teams adopting Gyst on a mature codebase (months or years of commits, PRs, bug fixes) start from zero knowledge. The most valuable data — the institutional memory encoded in past fix-type commits — is invisible.

**Why this matters**

1. A new hire onboarding a 2-year-old codebase would benefit most from seeing past fix patterns and architectural shifts. Today Gyst can't show any of them.
2. Users experience Gyst as "empty" on install, which directly contradicts the promise of "shared team memory."
3. The same data is already sitting in git; not using it is pure waste.

**How to implement**

1. Add `gyst backfill [--since <date>] [--max <N>]` CLI command:
   - Walks `git log` newest-to-oldest up to `--max` commits (default: 500).
   - For each commit, invokes the same `captureCommit()` path used by the post-commit hook, so the same significance threshold and AI-marker logic applies.
   - Deduplication is automatic via the existing compiler pipeline (same title + content fingerprints collapse).
2. Optionally accept `--author <email>`, `--paths <glob>` filters so teams can scope backfill to specific contributors or areas.
3. Progress indicator — print one line per 50 commits so long runs are observable.
4. Idempotent — re-running backfill on already-captured commits is a no-op (dedupe absorbs them).

**What backfill won't do**

Only git commits. Old Slack messages, Jira tickets, pull request discussions, and past AI chat sessions are out of scope for V1 — they require separate integrations and external credentials. Session transcripts are already handled by the existing `harvest` command; backfill does not try to reconstruct past AI sessions.

---

### 3. Install-Time Privacy Prompt — "Where does my knowledge live?"

**Status:** ⏳ Not started

**In plain English**

By default, Gyst saves knowledge into your project folder where it often ends up committed to git. For consulting or client work, that means traces of AI usage (Claude co-author markers, `ai-authored` tags, agent writing style) can leak into the client's repository — which is often confidential or contractually restricted.

**Real-world analogy**

Imagine you're a consultant using ChatGPT to help draft a client report. The report itself is fine. But every time you save, your computer also writes a log called "here's everything I asked ChatGPT for help with" into the folder you email to the client.

That's roughly what today's Gyst does.

**The three ways out**

| Path | What it means | Best for |
|---|---|---|
| **Path 1 — Local only** | Knowledge stays on your computer. No team sync. Totally private. | Solo users, non-technical users |
| **Path 2 — Private knowledge repo** | Your code stays in the client repo; knowledge goes in a separate private repo only your team can access. | Agencies, consulting firms |
| **Path 3 — HTTP server** | Knowledge lives on a tiny server your team runs. Never touches git at all. | Mid-size teams, regulated industries |

**The technical problem**

The default install assumes the user is fine committing `gyst-wiki/` and AI-usage traces to the project repo. That's safe for open-source or internal products, but professionally risky for agency/consulting/client work where AI usage is often confidential or contractually restricted. Leaks include `Co-Authored-By: Claude` commit markers, `ai-authored` tags, agent-authored content style, and the presence of `.mcp.json`.

**Why this matters**

1. Consulting firms, agencies, and regulated-industry developers lose deniability about AI tool usage when the wiki lands in the client's git history.
2. Users who discover this late have to rewrite git history (destructive) or abandon the tool entirely.
3. Gyst's value proposition (team-shared AI knowledge) is directly at odds with the privacy needs of a major adopter segment unless we give them a path.

**How to implement**

1. Extend `gyst install` with a scope-selection prompt (skipped under `--minimal` with sensible default):

   ```
   Who will use this knowledge base?
     1. Just me (solo)                        → Path 1 (local only)
     2. My team, internal/OSS code            → Path 1 (local only)
     3. My team, some client work             → Path 2 (private wiki repo)
     4. My team, strict privacy required      → Path 3 (HTTP server)
   ```

2. **Path 1 (local only)** — keep current behaviour but ensure `gyst-wiki/` is in project `.gitignore` by default. DB stays in `.gyst/wiki.db` (already gitignored).

3. **Path 2 (private wiki repo)** — prompt for a separate repo path, configure `wikiDir` to point there, initialise the target if empty. Client repo stays clean; knowledge syncs via `git pull` on the sibling repo.

4. **Path 3 (HTTP server)** — prompt for a server URL and invite key (or offer to start `gyst serve` locally). Wire up Bearer-token MCP config, skip all local wiki file writes.

5. Add `gyst privacy` CLI to switch modes after install without reinstalling.

**Decision matrix (include in user-facing docs)**

| Persona | Recommended path | Why |
|---------|------------------|-----|
| Solo dev / non-technical user | Path 1 | No team to sync with; simplest possible setup |
| Small team, internal/OSS code | Path 1 | Commit-to-repo sync is fine; no privacy constraint |
| Small team, client work (2–10 devs) | Path 2 | Familiar git workflow; zero infra; client repo clean |
| Mid/large team (10+) | Path 3 | Real-time sync; central auth; no git pollution |
| Regulated industry | Path 3 (self-hosted) | Data never leaves internal network |

**Caveats**

- Path 3 requires operational responsibility (someone must run the server). The installer should warn about this before committing to this path.
- Switching modes after install (e.g. Path 1 → Path 3) requires `gyst privacy migrate` to export existing data and re-import it on the server.

---

### 4. Related Smaller Gaps

**Status:** ⏳ 5 sub-items pending (scope trap, browse, PATH banner, Windows probe paths, wikiDir resolution)

These are shorter-lived issues that still affect real users every day. Each is individually fixable and doesn't need a full problem / implementation breakdown.

| Gap | In plain English | Why it matters |
|---|---|---|
| **Personal scope trap** | Entries you add via the command line are secretly tagged "personal," and search silently hides "personal" entries. You save something, search for it, nothing shows up — and nothing tells you why. | The single biggest blocker for new users. Most quit within five minutes thinking Gyst is broken. |
| **No browse command** | You can only find entries by typing a search query. There's no way to just list everything you've saved, filter by type, or scan what's there. | Users can't audit their own knowledge base without inventing queries and hoping for hits. |
| **Help text lies about `gyst`** | The help output tells you to run `gyst recall "foo"` even when that command doesn't exist on your PATH. You follow the instructions, it fails, you're stuck. | Every new contributor wastes their first session figuring out the gap between docs and reality. |
| **Windows runs at 10% quality silently** | The smartest search feature (finding entries by meaning) needs a library that only exists on Mac/Linux by default. On Windows it's quietly disabled — you get much worse results with no warning. | Windows is the most common developer OS. This is a critical silent failure affecting the biggest user segment. |
| **Files land in wrong folders** | If you're in the wrong folder when saving knowledge, Gyst sometimes writes markdown files to random places instead of the proper `gyst-wiki/` location. | Related to the project-root bug above. Fix both together. |

**How to implement (quick sketches)**

- **Scope trap** — change the default for CLI-added entries from `personal` to `team`, or prompt once on first `gyst add`.
- **No browse** — add `gyst list [--type <t>] [--tag <t>] [--limit <n>]` returning a table of title / type / confidence / updated_at.
- **Help lies** — detect `$PATH` at startup; if `gyst` isn't resolvable, print a one-line banner with the correct invocation form.
- **Windows degraded** — add Windows SQLite probe paths and ship a bundled `sqlite-vec` DLL (full plan in the Windows entry below).
- **Wrong folders** — fix at the same time as project-root awareness; resolve `wikiDir` relative to the discovered project root, not `process.cwd()`.

---

### 5. Strategic Gaps vs Commercial Alternatives

**Status:** ⏳ 5 sub-sections pending (Setup Friction, UX Immaturity, Windows Degraded, No Ecosystem, Marketing Asymmetry)

The items above are bugs and missing features. **These are bigger — they're the product-level gaps that determine whether Gyst wins or loses against paid competitors like Mem0, ByteRover, and Packmind.**

Each one honestly concedes the gap, paints what "fixed" looks like, and sets a measurable target. A reader should come away seeing: we know where we stand, we have a plan, and we know how we'll measure success.

---

#### Setup Friction

**In plain English**

Competitors like Mem0 take two commands: `pip install` plus one API call. Gyst needs Bun installed, repo cloned, build run, PATH edited, troubleshoot, try again.

**Real-world analogy**

A Nespresso capsule machine (drop pod, press button, done) versus a full manual espresso setup with a grinder, tamper, scale, thermometer, and three YouTube tutorials. The coffee might be comparable; the friction decides who actually uses it.

**The technical gap**

Install requires terminal literacy, Bun installation, PATH editing, and basic git knowledge. Mem0 is one `pip install` plus one API call.

**What "fixed" looks like**

- Windows/macOS installer binaries (`.exe`, `.pkg`) that bundle Bun and handle PATH automatically.
- Auto-detect AI tools already present; enable them with a single confirmation.
- Post-install wizard that walks through first entry, first recall, and a sanity check.
- "Zero-config mode" — running `gyst` with no arguments does the obvious thing in an initialised project.

**Target**

Time-to-first-recall under 60 seconds for a technical user, under 3 minutes for a non-technical one.

---

#### UX Immaturity

**In plain English**

First-use testing surfaces multiple blocking bugs at once — scope trap, PATH mismatch, no `list`, no `status`. Each is individually small. Together they push new users out the door within their first ten minutes.

**Real-world analogy**

A new restaurant where the menu has typos, the bathroom's broken, the waiter forgets your order, and when you complain, nobody can tell you why. The food might be excellent, but you'll never come back.

**The technical gap**

First-use testing surfaces multiple blocking bugs (scope filter hides all CLI entries, help text prints a command that doesn't exist on PATH, no `gyst list`, no `gyst status`). Any one of these is enough to make a new user quit in the first ten minutes.

**What "fixed" looks like**

- `gyst add` defaults to team scope, or prompts on first use.
- `gyst doctor` subcommand that runs a self-check — DB accessible, extensions loaded, hooks installed, PATH set — and prints a specific next action for each failure.
- `gyst list [--type <t>] [--tag <t>]` for browsing without forcing a search query.
- Help output detects whether `gyst` is on PATH and prints the correct invocation form.
- Human-readable recall output: title, type, confidence, content preview — not just an ID and a score.

**Target**

Every error message points at a specific next action. Zero silent failures.

---

#### Windows Degraded

**In plain English**

The smartest feature — semantic search, finding entries by meaning — needs a library that macOS and Linux have by default but Windows doesn't. On Windows, Gyst silently disables this feature and runs at roughly 10% hit rate instead of 78%. **Nothing tells the user this is happening.**

**Real-world analogy**

A car that only works at 10% power in the rain and doesn't warn the driver. Either put proper tires on, or at minimum turn on a dashboard warning light. Gyst currently has neither.

**The technical gap**

No Windows paths in `SQLITE_PROBE_PATHS`; `canLoadExtensions()` silently returns false; semantic search is disabled without any visible signal to the user. Windows is the most common developer OS worldwide — this is a critical gap.

**What "fixed" looks like**

- Add Windows paths to `SQLITE_PROBE_PATHS`: `%USERPROFILE%\scoop\apps\sqlite\current\sqlite3.dll`, `%ProgramData%\chocolatey\lib\SQLite\tools\sqlite3.dll`, and equivalents.
- Ship a Windows installer that bundles `sqlite-vec` as a DLL inside the npm package so no external SQLite install is required.
- Surface extension-loading failures through `gyst doctor` and the dashboard — not just buried in stderr logs nobody reads.
- Extend the CI test matrix to include `windows-latest` runners so Windows regressions fail the build.

**Target**

Parity with macOS and Linux on search quality out of the box, with zero manual setup steps on Windows.

---

#### No Ecosystem

**In plain English**

Competitors ship with templates (pre-made starter packs), integrations (Slack, Jira, Notion), mobile apps, VS Code extensions, and communities (Discord or Slack channels where users help each other). Gyst ships with 900+ tests and an architecture document — excellent for contributors, invisible to everyone else.

**Real-world analogy**

Two restaurants with equally good food. Restaurant A has a website, social media, Yelp reviews, a mobile ordering app, and a Google Maps listing. Restaurant B has none of that. People find A and never hear about B — no matter how good the food is.

**The technical gap**

Commercial competitors ship with templates, integrations, mobile apps, VS Code extensions, and a community (Discord / Slack). Gyst ships with 900+ tests and an `ARCHITECTURE.md` — excellent for contributors, invisible to adopters.

**What "fixed" looks like**

- **Template library** — pre-built ghost-knowledge packs for common stacks (`react-ts-starter`, `python-fastapi-starter`, `go-microservices-starter`). One `gyst template apply react-ts` installs 20 baseline conventions so new users don't stare at an empty database.
- **Public demo site** users can try before installing.
- **Staged integrations** — Slack bot (already a V2 placeholder), Jira ticket ingestion, Linear, GitHub Discussions.
- **Community forum** (Discord or GitHub Discussions) with weekly changelog posts.
- **Landing-page screencast** showing an agent using Gyst in real time.

**Target**

A new visitor understands what Gyst does and sees it in action within 30 seconds of landing on the homepage.

---

#### Marketing Asymmetry

**In plain English**

Commercial competitors have seed funding, dedicated marketing budgets, Twitter/X presence, conference talks, and venture-capital credibility. Gyst mostly has word-of-mouth. This isn't about product quality — it's about awareness.

**Real-world analogy**

A great indie band versus a major-label band with the same quality of music. The indie band's problem isn't the songs; it's that nobody has heard of them yet.

**The technical gap**

Commercial competitors have seed funding, marketing budgets, X presence, and the YC brand. Gyst ships with fewer external signals of legitimacy.

**What "fixed" looks like**

- **Lean into the YC brand** — founder presence on X, YC launch post, demo-day exposure. Being a YC company is a credibility signal; use it.
- **Coordinated launch** on Hacker News and Product Hunt on the same day with a clear story: "open-source team memory layer, works with any AI tool, runs locally, MIT licensed."
- **Publish benchmark numbers prominently** — LongMemEval 94.2%, CodeMemBench 78% Hit Rate. Most competitors don't publish these, so the comparison advantage is genuine.
- **Content strategy** — biweekly blog posts about real problems Gyst solves (faster onboarding, cross-tool knowledge retention, tribal knowledge capture). Problem stories, not feature announcements.
- **Design partner programme** — pick 5 teams, help them personally install and adopt, publish case studies. Each case study is worth more than a month of feature blogs.

**Target**

A founding engineer at any tool-agnostic AI-native startup has heard of Gyst within 6 months of the public launch.

---

### 6. Necessary-Maker Improvements — Nice-to-Have → Must-Have

**Status:** ⏳ 4 sub-sections pending (6a ambient capture, 6b session import, 6c weekly impact, 6d killer use-case)

The earlier sections fix bugs and catch us up to competitors. **This section is about crossing the line where stopping Gyst becomes painful** — the difference between "a tool I heard of" and "a tool I can't work without."

Think of it like git: you don't say "I use git." You assume all code is in git. Anyone who doesn't is the weird one. Gyst is nowhere near that today. These are the moves that get us there.

#### Priority Matrix

Each item scored by how much it moves Gyst from nice-to-have (🔴) toward must-have (🔴🔴🔴🔴🔴).

| # | Improvement | Necessary-Maker Score | Effort | Status |
|---|---|---|---|---|
| 1 | **Ambient capture from sessions** — no manual `learn()` needed | 🔴🔴🔴🔴🔴 | High | New — see below |
| 2 | **Import from past Claude/Cursor sessions** — day-one population | 🔴🔴🔴🔴 | Medium | New — see below |
| 3 | **Git history backfill** | 🔴🔴🔴🔴 | Medium | Already specified in §2 |
| 4 | **Weekly impact report** — "you saved 3.2 hours this week" | 🔴🔴🔴🔴 | Low | New — see below |
| 5 | **Specific killer use case** — own one wedge completely | 🔴🔴🔴 | Strategic | New — see below |
| 6 | **Template library** — React / Python / Go starters | 🔴🔴🔴 | Medium | Covered in §5 (No Ecosystem) |
| 7 | **Zero-friction install on Windows** | 🔴🔴🔴 | Medium | Covered in §5 (Windows Degraded) |
| 8 | **Fix scope trap and other blockers** | 🔴🔴 | Low | Covered in §4 (Related Gaps) |

Items 1–4 are the leverage points. Fix those, and Gyst goes from "a product I heard of" to "a tool I actually use daily." Items 8 alone won't make Gyst necessary — they'll just stop making it annoying.

---

#### 6a. Ambient Capture — "Gyst learns without being asked"

**In plain English**

Today, Gyst only captures knowledge when someone takes an explicit action — the agent decides to call `learn()`, or you manually run `gyst add`, or a commit is significant enough for the git hook to notice. Most of what you actually teach your agent during a session never gets saved. Users don't feel Gyst working because most of the time, it isn't.

**Real-world analogy**

Think of a recording studio engineer who only presses "record" when someone shouts "record!" — versus one who records everything continuously and lets you mark highlights afterward. The second engineer never misses the take. Gyst is currently the first kind; it should be the second.

**Why this matters**

1. Roughly 90% of the teaching moments in a real session happen in passing ("oh, we never do X because Y") and never get captured under the current model.
2. Users lose the habit because they don't see Gyst getting smarter over time — it mostly doesn't.
3. The entire value proposition ("shared memory that compounds") depends on capture rate being high. Low capture = no compound growth = no long-term value.

**What "fixed" looks like**

- **Continuous session watching** — an optional process that observes the active Claude/Cursor session in real time, extracting knowledge candidates from the conversation as it happens.
- **Code-diff inference** — when you modify a file, Gyst analyses the change and asks "is this a fix pattern? A new convention? A dependency bump?" and saves accordingly.
- **Conversational markers** — when the human says "never use X" or "always do Y" or "from now on we use Z," Gyst captures the convention automatically without the agent needing to think about it.
- **Reviewable silent capture** — nothing goes to the shared knowledge base unreviewed; the dashboard shows a pending-capture queue the user can approve in bulk.

**How to implement**

1. Extend the existing `harvest` pipeline to run continuously against a session transcript buffer instead of only at session end.
2. Add a `gyst watch` background process that hooks into MCP traffic and extracts candidates on the fly.
3. For code-diff inference, use git's `post-index-change` hook or a file-system watcher scoped to the project root.
4. All auto-captured candidates land in `status: pending_review` until the user confirms, preventing noise from polluting the shared base.
5. Provide a keyboard shortcut in the dashboard: review 10 pending entries in 30 seconds.

**Target**

In a user's last 100 Claude sessions, **Gyst captured ≥80% of the moments where they taught the agent something**. Today that number is near zero.

---

#### 6b. Historical Import from AI Session Files — "Day-one value"

**In plain English**

When someone installs Gyst today, the database is empty. They have to use it for weeks before it becomes useful. Meanwhile, they already have months of Claude Code and Cursor sessions on their laptop containing real lessons they've learned. Gyst doesn't look at any of them.

**Real-world analogy**

Imagine hiring an assistant who has been watching you work for a year, then on their first day they say "I remember nothing, please teach me everything from scratch." That's what Gyst's first-day experience is today. The assistant has the memories; the assistant chooses to ignore them.

**Why this matters**

1. Day-one value transforms adoption curves. Users who feel "this tool already knows my project" stick around. Users who face an empty database quietly drift away.
2. The data is already on the user's disk — ignoring it is pure waste.
3. Combined with the git history backfill (§2), a new Gyst install could arrive with hundreds of entries already extracted and ready.

**Why this is also risky**

Past AI sessions contain:
- Private questions the user doesn't want teammates to see
- Debugging embarrassments
- Personal queries unrelated to work
- Secrets or credentials accidentally pasted into chat
- Speculative ideas that were never actually implemented

Feeding all of that automatically into a team-shared knowledge base would destroy trust in a single install.

**What "fixed" looks like — opt-in, reviewable flow**

```
gyst import --from claude-code

  ├── Scans ~/.claude/projects/<this-repo>/*.jsonl for session files
  ├── Runs harvest on each (extracts candidates using existing pipeline)
  ├── Shows a preview: "Found 23 potential entries. Review? [Y/n]"
  ├── User approves / rejects / edits each one
  └── Only approved entries hit the shared knowledge base
```

**How to implement**

1. Add session-file readers per tool: Claude Code (`~/.claude/projects/<repo-hash>/*.jsonl`), Cursor (its local session dir), etc. Each needs a parser because formats differ.
2. Route parsed sessions through the existing `harvestTranscript()` function — same compiler pipeline, same dedup, same security stripping.
3. Mark imported candidates `status: pending_review` (same mechanism as ambient capture).
4. Dashboard UI for bulk review: approve-all, reject-all, edit-then-approve.
5. CLI alternative for users who don't want the dashboard: `gyst import --review-interactive` walks through candidates one at a time.

**Privacy controls to include from day one**

- Opt-in only — never scans session files without explicit CLI invocation.
- User sees every candidate before anything persists.
- Option to restrict scan to sessions matching a project path.
- Security stripping runs automatically (no credentials, tokens, keys).

**Target**

A new Gyst install offers to import past sessions; **80% of users who accept complete the review flow, and the resulting database has ≥50 quality entries on day one**.

---

#### 6c. Weekly Impact Report — "Prove value, keep the habit"

**In plain English**

Today there's no visible signal that Gyst is actually making you faster. Users lose the habit of using it because they can't see the wins. A weekly report that quantifies time saved and highlights top-useful entries turns invisible value into a dopamine hit users want to see every week.

**Real-world analogy**

Fitness trackers don't just measure steps — they tell you "you walked 8,000 steps today, that's 15% more than last week" and "you hit your weekly goal, great work." Users wear the tracker because the feedback loop is visible. Gyst today measures usage but shows the user nothing; no feedback loop, no habit.

**Why this matters**

1. Retention is the single biggest long-term metric for any developer tool. Users who see impact don't churn; users who don't, do.
2. Impact reports double as social proof — users share them ("my team saved 11 hours last week using Gyst") which drives word-of-mouth.
3. It turns Gyst from "another tool I installed once" into a weekly ritual.

**What "fixed" looks like**

Example weekly email / dashboard panel:

```
Your Gyst Week — April 20, 2026
────────────────────────────────
You saved ~3.2 hours this week by not re-debugging issues
Gyst already had fixes for.

Most-used entries:
  1. "auth session undefined error"   — used 7 times, saved ~4 hrs
  2. "API rate limit handling"        — used 3 times, saved ~1 hr
  3. "never deploy Friday afternoon"  — prevented 1 incident

New knowledge added by your team: 12 entries
  - Alice contributed 7
  - Bob contributed 3
  - You contributed 2

Weak spots (low-confidence entries that might need review): 4
```

**How to implement**

1. Add a `weekly_impact_reports` table recording per-user usage stats: recalls, saved-hour estimates (based on average debug-session length × recall count), top entries, team contribution split.
2. Saved-hour heuristic: for each unique recall-then-match event, estimate "avoided X minutes of re-debugging" using a tunable default (e.g. 30 min per `error_pattern` hit, 15 min per `convention` hit).
3. CLI: `gyst recap --weekly` prints the report. Cron-friendly so users can schedule it.
4. Dashboard: Impact panel shows this week's numbers live, previous weeks in a chart.
5. Optional: email digest once per week (opt-in, unsubscribable).

**Target**

**80% of users active 30+ days remain active after 6 months.** Today's retention is likely far lower. The impact report is the single biggest retention lever.

---

#### 6d. Specific Killer Use Case — "Own one wedge completely"

**In plain English**

"Shared memory for AI agents" is abstract. Nobody wakes up thinking "I need shared AI memory today." They wake up thinking "I have to onboard three new engineers" or "Alice is quitting and she knows everything." Gyst needs to own one specific, named, painful problem so well that when someone hits that pain, Gyst is the first tool they think of.

**Real-world analogy**

Notion is marketed as an all-in-one workspace — everyone knows about it but few feel pulled to it. Linear picked one wedge (issue tracking for fast teams) and owned it completely. Within three years, saying "we use Linear" became a shorthand for "we're a serious engineering org." That's what happens when you own a wedge.

Gyst today is the Notion of AI memory: general, capable, not urgent. It needs to become the Linear of something specific.

**Four candidate wedges**

Each is a legitimate way to become necessary. Pick one to lead with — the others are secondary features under the chosen wedge.

**a. The onboarding killer**
- Pitch: "Install Gyst, run `gyst onboard` — new hires read 10 pages, get 80% of institutional context."
- Measurable promise: "time-to-first-PR for new engineers drops from 6 weeks to 1 week."
- Who buys: VPs of Engineering at growing teams.
- Wedge ceiling: HR and enterprise onboarding tools.

**b. The knowledge insurance play**
- Pitch: "What happens to your company when Alice quits? Gyst means her knowledge doesn't quit with her."
- Measurable promise: "when a senior engineer leaves, 60%+ of their tribal knowledge is retained vs. today's ~0%."
- Who buys: CTOs worried about bus-factor; private equity firms pre-acquisition.
- Wedge ceiling: knowledge management / BCP (business continuity).

**c. The audit / compliance tool**
- Pitch: "Every architectural decision your team made in Q1, with evidence, ranked by impact. For regulators and auditors."
- Measurable promise: "audit-prep time drops 80% when engineering decisions are already machine-queryable."
- Who buys: compliance officers in regulated industries (health, finance, gov).
- Wedge ceiling: GRC (governance, risk, compliance) platforms.

**d. The cross-team knowledge arbitrage**
- Pitch: "Team A's solutions are findable by Team B without anyone knowing anyone else."
- Measurable promise: "duplicated work across engineering teams drops by 40%."
- Who buys: CTOs / platform teams at companies with 20+ engineering teams.
- Wedge ceiling: enterprise internal-tooling.

**How to decide**

Each wedge implies a different product focus, marketing story, and buyer persona. Pick based on:
1. **Which pain is loudest in Gyst's early users?** Ask the design-partner cohort (§5 Marketing).
2. **Which wedge has the clearest measurable ROI?** Onboarding and insurance both have hard numbers; audit is more squishy.
3. **Which buyer is easiest to reach?** VP Eng (onboarding) is reachable via content marketing. Compliance officers are harder.

Initial recommendation: lead with **onboarding killer** because it's the widest pain, easiest to demo, and the metrics (time-to-first-PR) are well-understood industry benchmarks.

**How to implement**

1. Ship a dedicated `gyst onboard` command that generates a markdown onboarding doc from the knowledge base, tailored per-role.
2. Build a landing page that leads with the wedge story, not the technical architecture.
3. Case study: install Gyst on 3 high-profile open-source projects and publish "how Gyst cut their new-contributor onboarding time."
4. Content: one long-form piece per month ("how to onboard a new engineer to an AI-native team in 2026") positioning Gyst as the answer.

**Target**

**"How do I onboard new engineers to an AI-native team?" — Gyst in the top 3 Google results.** Today it's nowhere on that SERP.

---

### 7. Structural Moats vs Model Vendors — "What can Anthropic/OpenAI not snipe?"

**Status:** ⏳ 4 sub-sections pending (7a SPEC.md, 7b non-chat capture, 7c positioning, 7d MCP tool consolidation)

Sections 5 and 6 close gaps against today's competitors (Mem0, ByteRover, Packmind). **This section is different. It's about positioning Gyst so that when Anthropic or OpenAI inevitably ship shared team memory — and they will, probably within 12 months — Gyst survives.**

Feature moats do not exist in this space. "We have team recall, they don't yet" is a 6-month lead, not a 5-year one. The only moats that last are the ones a model vendor is **structurally forced not to build**: multi-vendor neutrality, self-hosted/regulated posture, an open format with install base, and capture surfaces outside chat.

Each subsection below is a concrete move toward one of those moats.

---

#### 7a. Publish `.gyst/` Format Spec — The Open-Protocol Bet

**In plain English**

Right now Gyst is a product. Useful, but copyable. If we write down the format of `.gyst/wiki.db` and the knowledge schema as an open spec, Gyst becomes infrastructure — the way `.git/` is. Anyone can implement it. But we're the reference implementation, we defined it, and any vendor who wants to interoperate has to speak our language.

**Real-world analogy**

Git the tool could have been killed a dozen times over (Mercurial, Bazaar, BitKeeper, internal Google tools all tried). Git *the format* — the `.git/` directory layout — outlived all of them because it was documented, open, and had install base. GitHub, GitLab, Bitbucket all had to adopt it rather than compete with it.

**The strategic problem**

Nothing stops Anthropic from shipping "Claude Team Knowledge" with a proprietary format tied to Claude Code. If that happens before we have an open spec with adoption, we become the second-best Claude-only option, except they own the client. Same for OpenAI. The only way a small team survives a model vendor moving into their category is to already be the standard.

**What "fixed" looks like**

1. `SPEC.md` in the repo root, version 0.1, documenting:
   - Directory layout (`.gyst/wiki.db`, `.gyst/config.json`, `.gyst/meta/`).
   - SQLite schema: `entries`, `entry_relationships`, `conventions`, `events`, `fts_*`, `vec_*` (column types, required vs optional, indexes).
   - Entry YAML frontmatter for the markdown export format.
   - MCP tool contracts (input/output schemas for `learn`, `recall`, `check`, etc.) as JSONSchema.
   - Confidence decay half-lives per entry type.
   - Required security transforms (sensitive-data stripping) for spec-compliant writers.
2. Versioning policy (`spec_version` column already in DB — formalize it).
3. Conformance test suite — a set of fixtures any implementation can run to claim "gyst-compatible."
4. License the spec under CC-BY-4.0 (docs) with the reference implementation staying MIT (code). Model vendors can implement the spec without touching our code.

**Why this matters**

1. Turns "copying Gyst" into "adopting Gyst." Same reason nobody forked git's format — they all implemented it.
2. Gives regulated / sovereign customers a reason to pick Gyst over a SaaS memory layer: the format outlives the vendor.
3. Makes the dashboard, team server, and future plugins a market, not a product. Anyone can build against the spec.
4. Defensible press angle: "the first open standard for team knowledge in AI coding."

**Target**

`SPEC.md` v0.1 published, 2+ independent implementations (even partial) on GitHub referencing the spec, and at least one blog post from outside the team describing Gyst as "the open format" — within 6 months of publication.

---

#### 7b. Non-Chat Capture Sources — Own The SDLC Surface

**In plain English**

Anthropic and OpenAI can see everything that happens inside their chat UIs. They cannot see PR review comments, Sentry alerts, Linear ticket resolutions, or incident post-mortems — those live in other companies' products. If Gyst pulls signal from all of those, it has a permanent advantage: more input than any model vendor can get.

**Real-world analogy**

A journalist with sources inside a company will always beat a journalist who only reads the company's press releases. Chat transcripts are the press release. The real story — what actually broke, what got decided, what the team learned — is scattered across PRs, tickets, alerts, and Slack threads.

**The strategic problem**

Today Gyst's capture surfaces are: manual `learn()` calls, git commits (post-commit hook), and session harvest. That's a subset of what a developer produces in a week. Meanwhile Anthropic's "memory" surface is every chat turn. If we only compete on chat-adjacent signal, they win on volume.

**What "fixed" looks like**

Three first-class, non-chat capture sources in V1.5:

1. **GitHub / GitLab PR review comments** — a webhook or CLI-pulled integration that ingests resolved review threads. Signal: "we decided not to do X because Y." This is where most design decisions actually land, and it never makes it into chat.
2. **Sentry / Datadog / Rollbar error ingest** — when an incident is acknowledged and resolved, pull the error signature + the fix commit SHA. Automatically create an `error_pattern` entry linking the two. Signal: "this error has been seen before, here's what fixed it."
3. **Linear / Jira ticket resolutions** — for tickets tagged as bugs or decisions, capture the resolution comment. Signal: closed-loop "problem → decision → outcome" linking.

Each source writes to the same `entries` table via the same compiler pipeline (dedupe, link, classify, decay). No source-specific schema — everything normalizes to the existing entry types.

**How to implement**

1. Add `src/capture/pr-comments.ts` — webhook receiver + pull-based backfill for GitHub/GitLab review threads. Authenticates via a per-team GitHub App install (one OAuth flow per team, not per-user).
2. Add `src/capture/error-ingest.ts` — webhook receivers for Sentry and Datadog; each incoming alert with a resolution event produces an `error_pattern` entry. Map fingerprint → normalized signature using existing `normalize.ts`.
3. Add `src/capture/issue-tracker.ts` — Linear and Jira integration via their respective webhooks. Only ingest tickets with a resolution state change + a human-written comment.
4. All three sources gated behind explicit `gyst enable <source>` commands and per-source config (no surprise connections).

**Why this matters**

1. Every capture source Anthropic doesn't have is a reason Gyst stays relevant after they ship memory.
2. The *ratio* of non-chat to chat signal is the durable metric. Once non-chat is >50% of entries, Gyst is no longer "memory for Claude" — it's the team's knowledge layer, and Claude is just one reader.
3. Makes the team server immediately more valuable than solo mode: these sources are org-level, not per-developer.

**Target**

Three non-chat capture sources in production, each contributing ≥15% of weekly new entries for an active team, within 9 months. Messaging shifts from "team memory for AI agents" to "SDLC knowledge layer, read by your agents."

---

#### 7c. Kill the Personal-Memory Framing — Positioning Discipline

**In plain English**

A lot of our README and marketing copy could be read as "memory for Claude Code." That's exactly the lane Anthropic owns (auto memory, CLAUDE.md) and will keep owning. Every time we sound like personal memory, we invite comparison we lose. Our lane is the *team* layer, the *multi-tool* layer, and the *self-host* layer. Copy has to reflect that relentlessly.

**Real-world analogy**

Slack never advertised itself as "email but faster." If they had, they would have been compared to email and lost. They advertised themselves as "where work happens" — a different category. We need the same discipline.

**The strategic problem**

Readers landing on the README skim for "what is this." If they see phrases like "shared memory for agents" without immediate teams/multi-tool/self-host signal, they mentally file Gyst next to claudemem / Mem0 personal memory — and then bounce, because those are free, one-click, and made by bigger companies.

**What "fixed" looks like**

1. First line of README moves from "Team knowledge compiler for AI coding agents" (good, keep) to also front-loading the **three anti-Anthropic signals in the subhead**: multi-tool, self-host, team-scoped. Something like: *"Open, self-hosted knowledge layer that every AI tool your team uses can read and write."*
2. Add an explicit `## Why not [Anthropic/OpenAI] memory?` section naming the alternatives:
   - Claude Code built-in memory / CLAUDE.md — per-user, per-project, Claude-only.
   - claudemem / Mem0 — personal memory, single-agent.
   - Cursor rules — Cursor-only, no decay, no structured types.
   - Gyst — team-scoped, multi-tool, open format, self-host, typed knowledge with decay and violation detection.
3. Kill or rewrite any README sentence that reads naturally with "my" instead of "my team's." Those are leaks into the wrong category.
4. Rewrite the one-liner in ARCHITECTURE.md § What Gyst Is from "Persistent, shared memory for AI coding agents" (ambiguous — sounds personal) to "The team knowledge layer for AI coding agents — open, self-hosted, tool-agnostic."

**Why this matters**

1. Positioning is the cheapest moat we can buy. Every other item in §7 costs weeks of engineering; this costs a day of writing.
2. When Anthropic ships team memory, customers comparing products will read our copy. If it's sharp on teams/open/self-host, we win the comparison. If it reads like personal memory, we lose it by default.
3. The whole §7 strategy only works if the top of the funnel already frames Gyst correctly. Positioning is the load-bearing wall; the features sit on top.

**Target**

Zero sentences in README or ARCHITECTURE.md that read as naturally personal-memory as team-memory. A fresh reader who skims for 30 seconds can correctly name: (1) it's team-scoped, (2) it works with tools beyond Claude, (3) it runs on our own infrastructure. Measure by asking 5 external readers and checking recall.

---

#### 7d. Consolidate MCP Tool Surface — Stop Adding, Start Merging

**In plain English**

We have 14 MCP tools. That's a lot. When an AI agent looks at a tool list, the bigger the list, the more often it picks the wrong tool (or no tool at all). Our next instinct when we find a gap should be to *merge* tools, not add a 15th.

**Real-world analogy**

A kitchen with 40 specialized knives is worse than a kitchen with 4 good ones. Not because 40 is impossible to use, but because every decision — which knife for this task — now costs attention. Agents have the same problem at much larger scale: every irrelevant tool increases the rate at which they pick wrong.

**The technical problem**

Several of the 14 tools overlap in ways the model struggles to distinguish from name alone:

- `recall` vs `search` vs `get_entry` — three ways to read, differ only in token-budget / detail.
- `conventions` vs `check_conventions` vs `check` — three ways to touch conventions.
- `failures` is a strict subset of `check` when called on a file with an error trace.
- `feedback`, `activity`, `status` are observability that could live under one `admin` tool.

Adding a 15th tool for (say) "PR comment ingest" would make this worse.

**What "fixed" looks like**

Consolidate to ~7-8 tools with richer parameters:

| New tool | Replaces | Differentiation by parameter |
|---|---|---|
| `read` | `recall`, `search`, `get_entry` | `mode: "ranked" \| "compact" \| "full"`, `id?` |
| `check` | `check`, `check_conventions`, `failures` | `scope: "conventions" \| "errors" \| "all"` |
| `conventions` | (keep) | — pure lookup, no search |
| `learn` | (keep) | — |
| `feedback` | (keep) | — |
| `graph` | (keep) | — |
| `harvest` | (keep) | — |
| `admin` | `activity`, `status` | `view: "activity" \| "health" \| "stats"` |

**How to implement**

1. Introduce the merged tools alongside the old ones.
2. Mark the old tools deprecated in their JSONSchema descriptions, and have the MCP server log a warning when they're called.
3. Update `README.md`, `ARCHITECTURE.md`, agent rule files, and the installer's auto-injected CLAUDE.md snippet to advertise only the new surface.
4. After one minor version of deprecation, remove the old handlers. Keep the SQL/compiler logic — only the MCP surface changes.

**Status: shipped.** `read`, `check`, and `admin` are the registered core tools. The seven legacy names (`recall`, `search`, `get_entry`, `check_conventions`, `failures`, `activity`, `status`) still accept calls but prepend a deprecation notice to their response and emit a `logger.warn`. Their handler logic has been moved into the unified tools so there is a single source of truth per behavior.

**Why this matters**

1. Smaller tool lists → better tool-selection accuracy. This directly moves every recall/check metric.
2. Easier to document, easier for users to remember, easier for agents to describe when asked what they just did.
3. Sets a cultural rule: *adding an MCP tool requires removing or merging one.* Prevents surface-area bloat from becoming permanent.

**Target**

Reduce from 14 MCP tools to 7-8 within one minor version, with no loss of capability and measurably improved tool-selection accuracy on the internal eval.

---

## Module Map

```
src/
├── capture/           ← Git hooks, session injection, manual entry
│   ├── git-hook.ts
│   ├── git-merge-hook.ts
│   ├── session-inject.ts
│   └── manual.ts
├── cli/               ← CLI commands (gyst setup, install, export, etc.)
│   ├── index.ts
│   ├── install.ts
│   ├── ghost-init.ts
│   ├── team-init.ts
│   ├── onboard.ts
│   ├── export.ts
│   ├── recap.ts
│   ├── harvest.ts
│   └── gemini-adapter.ts
├── compiler/          ← Knowledge processing pipeline
│   ├── extract.ts         Entity extraction + Zod validation
│   ├── normalize.ts       Error signature normalization
│   ├── deduplicate.ts     Fingerprint + Jaccard dedup
│   ├── linker.ts          Relationship discovery
│   ├── writer.ts          SQLite write + optional markdown export
│   ├── consolidate.ts     Multi-stage batch consolidation
│   ├── classify-event.ts  Stage 1: rule-based classifier
│   ├── classify-rerank.ts Stage 2: graph-based reranking
│   ├── classify-distill.ts Stage 3: LLM distillation
│   ├── classify-eval.ts   Eval harness (bloat score gate)
│   ├── detect-conventions.ts  AST-based convention discovery
│   ├── store-conventions.ts   Persist detected conventions
│   ├── graphify-transformer.ts  Graphify AST → structural index
│   ├── security.ts        Sensitive data stripping
│   ├── check-violations.ts   Convention violation checking
│   ├── entities.ts        Named entity extraction
│   ├── patterns.ts        Pattern detection
│   ├── exporter.ts        Export utilities
│   ├── distill.ts         LLM distillation logic
│   ├── distill-scheduler.ts  Batch budget management
│   ├── process-events.ts  Pipeline orchestration
│   └── parsers/           Per-event-type parsers
│       ├── commit.ts
│       ├── error.ts
│       ├── prompt.ts
│       ├── markdown-adr.ts
│       └── markdown-headings.ts
├── dashboard/         ← HTTP dashboard server + React UI
│   ├── server.ts          Express server (port 3579), 20+ API endpoints
│   ├── index.html         Legacy D3 force graph (served at /legacy)
│   └── ui/                React 18 + Vite + Tailwind SPA
│       ├── src/           Components: Masthead, ModeRail, Feed, Sidebar, CaptureModal, InviteModal, EntryDrawer
│       └── dist/          Built output (served as static files)
├── mcp/               ← MCP server + 14 tools
│   ├── server.ts          Stdio transport entry point
│   ├── register-tools.ts  Tool registry
│   ├── installer.ts       Auto-detect + configure AI tools
│   ├── events.ts          Event dispatcher
│   └── tools/             One file per tool
├── server/            ← HTTP transport + team mode
│   ├── http.ts
│   ├── auth.ts
│   ├── team.ts
│   └── activity.ts
├── store/             ← SQLite storage layer
│   ├── database.ts        Schema, migrations, WAL setup
│   ├── search.ts          5-strategy search + RRF fusion
│   ├── confidence.ts      Scoring + decay
│   ├── embeddings.ts      sqlite-vec + MiniLM-L6-v2
│   ├── entries.ts         Entry CRUD
│   ├── events.ts          Event logging
│   ├── graph.ts           Knowledge graph traversal
│   ├── hybrid.ts          Hybrid search combining strategies
│   ├── intent.ts          Query intent classification
│   ├── query-expansion.ts Synonym expansion
│   ├── rebuild.ts         Schema migration utilities
│   ├── structural.ts      Structural AST node indexing
│   ├── temporal.ts        Time-based filtering
└── utils/             ← Shared utilities
    ├── config.ts
    ├── logger.ts
    ├── errors.ts
    ├── tokens.ts
    ├── age.ts
    ├── format-recall.ts
    └── llm.ts
```

---

## Running the Project

```bash
# Install
bun install

# Dev
bun run dev              # Start MCP server in watch mode
bun run dashboard        # Start dashboard at localhost:3579

# Test
bun test                 # All 900+ tests
bun run lint             # TypeScript type check
bun run eval:classifier  # Classifier eval (bloat score gate)

# Benchmark
bun run benchmark:codememb     # CodeMemBench
bun run benchmark:longmemeval  # LongMemEval-S
bun run benchmark:coir         # CoIR (requires Python venv)
bun run benchmark:combined     # Combined report

# Build & Publish
bun run build            # Compile to dist/
npm publish              # Publish to npm (runs prepublishOnly checks)
```
