# Gyst

**Team knowledge compiler for AI coding agents.**

---

AI coding agents are everywhere. Claude Code, Cursor, Codex, Gemini — every developer on your team has one. But each agent only knows what happened in its own session. When your teammate's agent figures out why the auth service keeps timing out, or discovers that you should never deploy on Fridays because of the batch job, or learns the right way to structure API responses — that knowledge dies at the end of the session. Your agent starts fresh tomorrow. Their agent starts fresh next week. The team never gets smarter, even as each individual gets faster.

Gyst is a shared memory layer that lives between your agents and your codebase. When an agent learns something worth keeping, it calls `learn()`. When any agent on the team needs context, it calls `recall()`. The knowledge base grows with every session, every fix, every decision — and every agent on the team has access to everything every other agent has ever learned. One developer's hard-won insight becomes the whole team's starting point.

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
