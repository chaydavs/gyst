# Gyst

**Team knowledge compiler for AI coding agents.**

*Open, self-hosted knowledge layer that every AI tool your team uses can read and write.*

---

AI coding agents are everywhere. Claude Code, Cursor, Codex, Gemini — every developer on your team has one. But each agent only knows what happened in its own session. When your teammate's agent figures out why the auth service keeps timing out, or discovers that you should never deploy on Fridays because of the batch job, or learns the right way to structure API responses — that knowledge dies at the end of the session. Your agent starts fresh tomorrow. Their agent starts fresh next week. The team never gets smarter, even as each individual gets faster.

Gyst is the team's shared knowledge layer — open format, self-hosted, and multi-tool from day one. When any agent on the team learns something worth keeping, it calls `learn()`. When any other agent needs context, it calls `recall()`. The knowledge base grows with every session, every fix, every decision — and every agent on the team reads the same entries regardless of which vendor's tool they're running inside. One developer's hard-won insight becomes the whole team's starting point, and your knowledge doesn't get trapped in whichever AI tool a teammate happens to prefer.

### Why not Claude memory / Mem0 / Cursor rules?

| | Scope | Tool coverage | Format |
|---|---|---|---|
| **Claude Code built-in memory / CLAUDE.md** | Per-user, per-project | Claude-only | Proprietary |
| **claudemem, Mem0** | Personal (single developer) | Single-agent | Vendor-hosted |
| **Cursor rules** | Per-repo | Cursor-only | No decay, no structured types |
| **Gyst** | **Team-scoped** | **Every tool on the team via MCP** | **Open `.gyst/` format, self-host or sync** |

If the knowledge you want to capture only matters to you, use a personal-memory tool. If it matters to your teammates — conventions, decisions, postmortems, onboarding — that's the category Gyst is for.

---

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
Install and set up Gyst for this project. Run `npx gyst-mcp install`,
then scan the codebase — read the README, package.json, recent git
history, and key source files. Use the learn tool to record conventions,
decisions, error patterns, and anything a new developer should know.
```

The agent runs the installer (which registers itself as an MCP server), restarts the connection, and immediately populates the knowledge base. Every future session in the project automatically has Gyst context injected at startup.

---

### Route B — Manual setup

**1. Install**

```bash
npx gyst-mcp install
```

Restart your AI tool when it finishes.

**2. Populate the knowledge base**

Tell your agent:

```
Scan this project with Gyst. Read the README, package.json, recent git
history, and key source files. Use the learn tool to record conventions,
decisions, error patterns, and anything a new developer should know.
```

**3. Use it**

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

## How Gyst runs — MCP tools vs. lifecycle hooks

Gyst runs on **two independent mechanisms**. Both write to the same knowledge base, but they are triggered by different things. Knowing the difference saves hours of debugging.

| | MCP tools | Lifecycle hooks |
|---|---|---|
| **Who triggers** | The model (agent) | The harness (Claude Code / Codex / Gemini) |
| **When** | Whenever the agent decides a tool is relevant | On fixed events: `SessionStart`, `PreCompact`, `SessionEnd` |
| **Configured in** | `~/.claude.json` (or equivalent) as an MCP server | `~/.claude/settings.json` (or `hooks.json`) |
| **What runs** | A tool handler in the Gyst MCP server | A shell command (`gyst inject-context`, `gyst harvest`, `gyst emit …`) |
| **Deterministic?** | No — depends on the agent's choice | Yes — fires on every matching event |
| **Examples** | `learn`, `recall`, `check`, `failures` | Inject ghost knowledge at session start; harvest before compaction |

```
                   Agent turn                         Harness event
                       │                                  │
                       ▼                                  ▼
                 MCP tool call                        Shell command
           (learn / recall / check …)        (gyst inject-context / harvest …)
                       │                                  │
                       └───────────┬──────────────────────┘
                                   ▼
                            .gyst/wiki.db
```

**One-line mental model:** MCP is what the model *can* call. Hooks are what Claude Code *will* call. Both end up in the same knowledge base.

The `gyst install` command sets up both: step 3 registers the MCP server, step 7 registers the lifecycle hooks. You'll see them as separate lines in the install output.

---

## MCP Tools

The surface is organized around three verbs — `read` (ranked search / compact index / single entry), `check` (convention violations / rule lookup / known error lookup), and `admin` (activity / status) — plus write-side and specialized tools.

### Core surface

| Tool | Purpose |
|------|---------|
| `read` | Unified read. `action: "recall"` (default) returns ranked full-content results, `action: "search"` returns a compact index (7× fewer tokens), `action: "get_entry"` fetches full markdown for one entry by id. |
| `check` | Unified check. `action: "violations"` (default) runs violation detectors against a file, `action: "conventions"` lists rules that apply to a path, `action: "failures"` looks up a known error pattern by message. |
| `admin` | Team observability. `action: "activity"` (default) shows recent knowledge events; `action: "status"` shows who's currently active and what files they're touching. |
| `learn` | Record knowledge: errors, conventions, decisions, learnings. |
| `feedback` | Rate an entry helpful/unhelpful — adjusts confidence. |
| `harvest` | Extract knowledge from a session transcript. |
| `conventions` | Coding standards for a file path or directory. |
| `graph` | Query the relationship graph. |
| `configure` | Adjust server configuration at runtime. |

### Deprecated (still registered for backward compat)

| Old tool | Use instead |
|----------|-------------|
| `recall` | `read({ action: "recall", query })` |
| `search` | `read({ action: "search", query })` |
| `get_entry` | `read({ action: "get_entry", id })` |
| `check_conventions` | `check({ action: "conventions", file_path })` |
| `failures` | `check({ action: "failures", error_message })` |
| `activity` | `admin({ action: "activity" })` |
| `status` | `admin({ action: "status" })` |

Deprecated tools continue to function but prepend a deprecation notice to responses. They will be removed in a future release.

### Ghost Knowledge

Ghost entries have infinite confidence and always surface first — they encode things your team knows but never wrote down:

```bash
gyst ghost-init   # interactive Q&A to capture tribal knowledge
```

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
| NDCG@10 | 0.327 |
| Hit Rate | 66.0% |
| Ghost Knowledge Hit | **92.0%** |

### LongMemEval (500 questions)
| Metric | Score |
|--------|------:|
| Hit Rate @5 | **94.2%** |
| MRR@5 | 0.837 |

---

## How it works

Five search strategies run in parallel on every query, fused with Reciprocal Rank Fusion:

1. **File path** — exact match on affected files
2. **BM25 via FTS5** — keyword search with code tokenization (camelCase → separate tokens)
3. **Graph traversal** — walk entity relationships
4. **Temporal** — recency-weighted for debugging/history queries
5. **Semantic** — 22MB local ONNX model, no API call required

The `install` command wires a `SessionStart` hook into your AI tools. At every session start, `gyst inject-context` automatically injects ghost knowledge rules and top conventions for the current directory.

---

## Architecture

```
src/
├── mcp/        # MCP server + 14 tools (stdio + HTTP)
├── compiler/   # Extract, normalize, deduplicate, link
├── store/      # SQLite + FTS5, 5-strategy search, RRF fusion, graph
├── server/     # HTTP server, auth, activity logging
├── dashboard/  # React knowledge UI
├── capture/    # Git hooks, session harvesting, context injection
└── cli/        # CLI commands
```

**Stack:** Bun · TypeScript · SQLite (FTS5) · `@modelcontextprotocol/sdk` · Zod

---

## Development

```bash
bun install
bun test                    # 958 tests, 63 files
bun run lint                # tsc --noEmit
bun run build               # bundle to dist/
bun run benchmark:codememb  # CodeMemBench
```

---

## License

MIT — see [LICENSE](LICENSE).
