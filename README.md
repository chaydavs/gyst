# Gyst

**Team knowledge layer for AI coding agents.**

---

AI coding agents are everywhere. Claude Code, Cursor, Codex, Gemini — every developer on your team has one. But each agent only knows what happened in its own session. When your teammate's agent figures out why the auth service keeps timing out, or discovers that you should never deploy on Fridays because of the batch job, or learns the right way to structure API responses — that knowledge dies at the end of the session. Your agent starts fresh tomorrow. Their agent starts fresh next week. The team never gets smarter, even as each individual gets faster.

Gyst is a shared memory layer that lives between your agents and your codebase. When an agent learns something worth keeping, it calls `learn()`. When any agent on the team needs context, it calls `recall()`. The knowledge base grows with every session, every fix, every decision — and every agent on the team has access to everything every other agent has ever learned. One developer's hard-won insight becomes the whole team's starting point.

---

## Install

**Requires Bun:**
```bash
curl -fsSL https://bun.sh/install | bash
```

```bash
npx gyst-mcp install
```

Detects Claude Code, Cursor, Codex CLI, Gemini CLI, Windsurf, OpenCode, VS Code, and Continue automatically. Registers the MCP server, initializes the database, scans for conventions, and installs git hooks. Restart your AI tool when it finishes.

---

## Getting Started

Two routes: let an agent do everything, or set it up yourself.

---

### Route A — Agent setup (one prompt)

Open your AI tool in a project and paste this:

```
Install and set up Gyst for this project:

1. Run `npx gyst-mcp install` and restart your MCP connection when it finishes.
2. Run `gyst self-document --skip-ghosts` to bootstrap the knowledge base from
   the codebase structure and all markdown files (specs, plans, ADRs, CLAUDE.md).
3. Scan the project — read the README, package.json, recent git history, and
   key source files. Use the learn tool to record conventions, decisions, error
   patterns, and anything a new developer should know.
```

The agent runs the installer, bootstraps the KB from your codebase in seconds (zero LLM calls with `--skip-ghosts`), then enriches it with session knowledge. Every future session automatically has Gyst context injected at startup.

---

### Route B — Manual setup

**1. Install**

```bash
npx gyst-mcp install
```

Restart your AI tool when it finishes.

**2. Bootstrap from codebase**

```bash
gyst self-document --skip-ghosts
```

This scans TypeScript source files and all markdown docs (specs, plans, ADRs, CLAUDE.md) and loads them into the KB — zero LLM calls, under 5 seconds.

**3. Enrich with agent knowledge**

Tell your agent:

```
Scan this project with Gyst. Read the README, package.json, recent git
history, and key source files. Use the learn tool to record conventions,
decisions, error patterns, and anything a new developer should know.
```

**4. Use it**

```bash
gyst recall "what should I know about this codebase"
gyst dashboard   # knowledge UI at localhost:3579
```

---

## Team Mode

### Solo / git-sync (zero infrastructure)

The wiki lives in your repo. `git pull` syncs knowledge automatically via the `post-merge` hook. Works out of the box.

### Remote teams (shared HTTP server)

One person hosts. Everyone else joins with a single command — no local DB, no config editing, no shared filesystem required.

**Admin — set up once:**

```bash
gyst create team "Acme Engineering"              # prints admin key
GYST_API_KEY=gyst_admin_... gyst team invite     # prints invite key
gyst serve --http --port 3456                    # start shared MCP server
```

Expose the server publicly (ngrok for testing, fly.io/Railway for production) and share:
- The server URL
- The invite key

**Each developer joins with one command:**

```bash
gyst join gyst_invite_abc123... "Alice" --server http://your-host:3456
```

That's it. Gyst automatically detects and reconfigures every AI tool on the developer's machine (Claude Code, Cursor, Codex, Gemini, Windsurf, VS Code) to point at the shared server. Restart the AI tool and every agent is connected — reading and writing to the same team knowledge base.

All 14 tools work identically over HTTP and stdio. Knowledge grows as the team grows.

---

## What it does

```
Developer A (Claude Code) ──┐
Developer B (Cursor)       ──┤  learn() ──► Team Knowledge Base ──► recall()
Developer C (Codex CLI)    ──┘                                   every agent reads this
```

Knowledge lives in your git repo or on a shared HTTP server. Nothing leaves your infrastructure unless you choose otherwise.

---

## MCP Tools (14)

| Tool | Purpose |
|------|---------|
| `learn` | Record knowledge: errors, conventions, decisions, learnings |
| `recall` | Ranked search — returns full entries within a token budget |
| `search` | Compact index (7× more token-efficient) — browse then `get_entry` |
| `get_entry` | Full markdown for one entry by ID |
| `conventions` | Coding standards for a file path or directory |
| `check_conventions` | Which conventions apply to a file |
| `check` | Run all violation detectors against a file |
| `failures` | Match a known error pattern by signature or keywords |
| `graph` | Query the relationship graph |
| `feedback` | Rate an entry helpful/unhelpful — adjusts confidence |
| `harvest` | Extract knowledge from a session transcript |
| `activity` | Recent team activity log |
| `status` | Health check and database stats |
| `configure` | Read/write project configuration |

### Ghost Knowledge

Ghost entries have confidence 1.0 and always surface first — they encode things your team knows but never wrote down. Two ways to create them:

```bash
gyst ghost-init       # interactive Q&A to capture tribal knowledge
gyst self-document    # auto-generate from codebase structure (see below)
```

The `self-document` command ranks every entry by degree centrality (relationship edges + co-retrieval links) and calls Haiku once per top-N hub node to generate a concise description. Ghost entries are regenerated only when the centrality ranking changes.

---

## Context Economics

Gyst tracks the ROI of your knowledge base locally — no external calls, no opt-in required.

**Leverage ratio** = tokens your agents received from recall ÷ tokens you invested writing entries. A ratio above 1.0 means the KB is already paying for itself. A ratio of 10 means every minute spent writing an entry saved ten minutes of context re-generation.

The dashboard surfaces:
- Leverage ratio and total token savings
- Zero-result rate (rising trend = KB going stale)
- Intent breakdown (debugging vs. conventions vs. conceptual queries)
- Recalls today / learns today

All data stays in your SQLite database. Nothing leaves your machine.

---

## Drift Detection

AI knowledge bases degrade silently. Gyst measures and surfaces drift before it causes problems.

**Three signals tracked automatically:**

1. **Zero-result rate trend** — compares your 7-day window against your 30-day baseline. A rising trend means your agents are asking questions the KB can't answer.
2. **Stale entries** — entries with decaying confidence that haven't been confirmed in 30+ days. The knowledge garden needs pruning.
3. **AI fatigue warning** — if your agents recalled knowledge 10+ times last week but no new entries were added, you're at risk of your intuition dulling. Gyst flags it.

**Anchor queries** let you define golden probe queries that should always return results. The dashboard's pulse check runs them on every load and flags any that return zero results — targeted knowledge loss, caught early.

The drift score (0–100%) and trend label (improving / stable / drifting) are always visible in the dashboard sidebar.

---

## Hooks

Gyst registers 12 hooks across every Claude Code lifecycle event:

| Hook | What Gyst does |
|------|---------------|
| `SessionStart` | Injects team context + ghost knowledge into every session |
| `UserPromptSubmit` | Records prompt patterns for knowledge classification |
| `InstructionsLoaded` | Auto-ingests CLAUDE.md / instructions files into the KB on load |
| `PreToolUse` | Status badge + tracks `Read` tool calls as KB miss signals |
| `PostToolUse` | Captures tool output; detects ADR/plan writes |
| `PostToolUseFailure` | Extracts error_pattern entries from failed tool calls automatically |
| `SubagentStart` | Injects ghost knowledge into every spawned subagent |
| `Stop` | Triggers session distillation — extracts knowledge from the full session |
| `SubagentStop` | Same distillation for subagent sessions |
| `PreCompact` | Harvests session knowledge before context is erased by compaction |
| `PostCompact` | Takes a drift snapshot after compaction completes |
| `FileChanged` (`**/*.md`) | Re-ingests changed markdown files into the KB immediately on save |

All hook emissions are fire-and-forget (detached spawns). Hooks return in under 1ms — no latency added to the agent loop.

---

## Dashboard

```bash
gyst dashboard
```

Opens at `localhost:3579`. Includes:

- **Feed** — browse all entries by type, scope, or keyword search
- **Review queue** — entries flagged for decay, low confidence, or explicit feedback
- **Graph view** — interactive knowledge relationship graph with distinct type colors (purple/ghost, red/error, yellow/decision, amber/convention, green/learning, cyan/md_doc, indigo/structural) and connection-density node sizing
- **Docs** — browse and preview all ingested markdown files (plans, specs, ADRs, CLAUDE.md); populated by `gyst self-document`
- **Team management** — member roster, per-member stats (contributions, recall count, recent activity), invite flow, danger zone
- **Context Economics** — leverage ratio, token savings, intent breakdown, zero-result rate
- **Knowledge Drift** — drift score, trend, stale entry count, AI fatigue warning, anchor query manager

---

## CLI Commands

| Command | What it does |
|---------|-------------|
| `gyst install` | First-time setup |
| `gyst serve` | Start MCP server (stdio) |
| `gyst serve --http [--port N]` | Start shared HTTP team server |
| `gyst recall <query>` | Search the knowledge base |
| `gyst add <title> [content]` | Manually add a knowledge entry |
| `gyst check <file>` | Check a file against stored conventions |
| `gyst detect-conventions` | Scan codebase for conventions |
| `gyst dashboard` | Launch knowledge UI at localhost:3579 |
| `gyst self-document [--skip-ghosts] [--ghost-count N]` | Bootstrap KB: structural skeleton + MD corpus + ghost knowledge |
| `gyst create team <name>` | Create a team and get an admin key |
| `gyst team invite` | Generate an invite key for a new member |
| `gyst team members` | List all team members |
| `gyst join <key> <name> [--server <url>]` | Join a team (local or remote) |
| `gyst ghost-init` | Interactive tribal knowledge capture |
| `gyst onboard` | Generate onboarding doc from knowledge base |

---

## Benchmarks

### Internal eval (50 queries)
| Metric | Score |
|--------|------:|
| MRR@5 | 0.977 |
| Recall@5 | 0.983 |
| NDCG@5 | 0.962 |

### CodeMemBench — team knowledge retrieval (200 queries)
| Metric | Score |
|--------|------:|
| NDCG@10 | 0.351 |
| Hit Rate | 78.0% |
| Ghost Knowledge Hit | **92.0%** |

### LongMemEval (500 questions)
| Metric | Score |
|--------|------:|
| Hit Rate @5 | **94.2%** |
| MRR@5 | 0.837 |

---

## Self-Documenting KB

`gyst self-document` bootstraps the knowledge base from your codebase in three phases, without any manual writing:

**Phase 1 — Structural skeleton** (zero tokens, ~2s)
Globs all TypeScript/JavaScript source files, extracts exports and imports, stores each file as a `structural` KB entry with hash-check. Subsequent runs skip unchanged files.

**Phase 2 — MD corpus** (zero tokens)
Scans `**/*.md` files (excluding node_modules, dist, gyst-wiki). Hash-checks each file — creates, updates, or skips. Frontmatter is parsed for title and tags. Section headings are extracted as a TOC prefix for better BM25 retrieval.

**Phase 3 — Ghost knowledge** (optional, ~$0.001)
Ranks all entries by degree centrality (relationship edges + co-retrieval links). Calls Haiku once per top-N hub node to generate a 2–4 sentence KB description. Ghost entries surface first on every `recall()`.

```bash
gyst self-document            # all three phases (requires ANTHROPIC_API_KEY for Phase 3)
gyst self-document --skip-ghosts  # Phases 1+2 only, zero LLM calls
gyst self-document --ghost-count 20  # generate top-20 ghost entries (default: 10)
```

The `FileChanged` hook re-ingests any `.md` file as soon as you save it. The `InstructionsLoaded` hook ingests `CLAUDE.md` at session start. Together they keep the KB current without any manual steps.

---

## How it works

Five search strategies run in parallel on every query, fused with Reciprocal Rank Fusion:

1. **File path** — exact match on affected files
2. **BM25 via FTS5** — keyword search with code tokenization (camelCase → separate tokens)
3. **Graph traversal** — walk entity relationships
4. **Temporal** — recency-weighted for debugging/history queries
5. **Semantic** — 22MB local ONNX model, no API call required

The `install` command wires into every hook event in your AI tools. At every session start, `gyst inject-context` automatically injects ghost knowledge rules and top conventions for the current directory. Every tool use, prompt, and session end is captured and processed in the background.

---

## Architecture

```
src/
├── mcp/        # MCP server + 14 tools (stdio + HTTP transports)
├── compiler/   # Extract, normalize, deduplicate, link, distill
├── store/      # SQLite + FTS5, 5-strategy search, RRF fusion, graph, embeddings
├── server/     # HTTP server, auth, activity logging
├── dashboard/  # React knowledge UI + team management
├── capture/    # Git hooks, session harvesting, context injection
├── utils/      # Analytics, drift detection, config, tokens, logger
└── cli/        # CLI commands
```

**Stack:** Bun · TypeScript · SQLite (FTS5) · `@modelcontextprotocol/sdk` · Zod · React (dashboard)

---

## Development

```bash
bun install
bun test                    # 970 tests, 67 files
bun run lint                # tsc --noEmit
bun run build               # bundle to dist/
bun run benchmark:codememb  # CodeMemBench
```

---

## License

MIT — see [LICENSE](LICENSE).
