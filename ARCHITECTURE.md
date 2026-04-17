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

---

## What Gyst Is

AI coding agents make every developer faster but no team smarter. Gyst fixes that.

Gyst is a **universal team knowledge layer** for AI coding agents. It captures conventions, error patterns, architectural decisions, and learnings from developer sessions and makes them available across tools via MCP. Works with Claude Code, Cursor, Codex CLI, Gemini CLI, Cline, Windsurf, and self-hosted LLMs.

Extends Karpathy's "LLM Wiki" pattern — where a single developer's context persists across sessions — to **teams**, where knowledge must be shared, deduplicated, decayed, and governed.

**One-liner:** Persistent, shared memory for AI coding agents.

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

14 tools available via both stdio and HTTP transports:

| Tool | Purpose | Key behavior |
|------|---------|-------------|
| `learn` | Record team knowledge | Entity extraction, auto-linking, dedup |
| `recall` | Search knowledge base | 5-strategy RRF fusion, ghost_knowledge boost, context budgeting |
| `search` | Compact index view | Returns id/type/confidence/title for progressive disclosure |
| `get_entry` | Full entry by ID | Markdown content + relationships + sources |
| `conventions` | List coding standards | Filter by directory/tags, confidence-sorted |
| `check_conventions` | Check file against rules | Returns violations with confidence scores |
| `failures` | Match error patterns | By signature fingerprint or BM25 keyword match |
| `check` | Pre-flight validation | Run all violation detectors against a file |
| `graph` | Explore relationships | Neighbors, path between entries, similar entries |
| `feedback` | Rate an entry | +0.02 (helpful) / -0.05 (unhelpful) confidence adjustment |
| `harvest` | Batch import | Extract knowledge from session transcript |
| `activity` | Team activity log | Who learned/recalled what, when |
| `status` | Health check | Entry counts, last updated |

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
