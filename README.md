# Gyst

**Give your AI agent your team's memory. In 90 seconds.**

```bash
npm install -g gyst-mcp && gyst init
```

---

## The problem

AI coding agents are fast — but stateless. Every session your agent starts fresh: no memory of why the auth service keeps timing out, no knowledge of the deploy-on-Fridays rule, no record of decisions your team made last month. Your agent figures things out and then forgets them. The team never gets smarter.

---

## The solution

- **Self-populating context layer** — mined automatically from your git history, code comments, markdown docs, and session transcripts
- **Every session starts ready** — your team's rules, conventions, and past decisions are injected before the first prompt
- **Works with every major agent** — Claude Code, Cursor, Codex CLI, Windsurf, Gemini CLI

---

## 90-second quickstart

```bash
npm install -g gyst-mcp && gyst init
```

**Example output:**

```
┌─────────────────────────────────────────────────────┐
│  gyst init                                          │
├─────────────────────────────────────────────────────┤
│  ✓ Database initialized      .gyst/wiki.db          │
│  ✓ MCP server registered     Claude Code            │
│  ✓ MCP server registered     Cursor                 │
│  ✓ Hooks installed           post-commit            │
│  ✓ Scanning codebase ...     42 files               │
│  ✓ Loaded conventions        8 entries              │
│  ✓ Loaded decisions          3 entries              │
│  ✓ Ghost knowledge generated 5 entries              │
├─────────────────────────────────────────────────────┤
│  Restart your AI tool. Context will inject on the   │
│  next session start.                                │
└─────────────────────────────────────────────────────┘
```

Restart your AI tool. That's it.

---

## What your agent gets

| Context type | What it is | Example |
|---|---|---|
| **Ghost Knowledge** | High-confidence facts about your codebase the agent must know | "Never deploy on Fridays — batch job runs at 22:00 UTC and will conflict" |
| **Conventions** | Coding standards scoped to files and directories | "All API responses use the `ApiResponse<T>` envelope shape" |
| **Decisions** | Architecture choices and the reasons behind them | "Switched from Prisma to raw SQL — N+1 queries were killing dashboard load time" |
| **Error Patterns** | Known failure signatures with their fixes | "`SQLITE_BUSY` on parallel writes — use WAL mode + retry with backoff" |

---

## Supported agents

| Agent | Auto-detected | Context injection | Hook coverage |
|---|:---:|:---:|:---:|
| Claude Code | ✓ | ✓ | 12 hooks |
| Cursor | ✓ | ✓ | 4 hooks |
| Codex CLI | ✓ | ✓ | 4 hooks |
| Windsurf | ✓ | ✓ | 4 hooks |
| Gemini CLI | ✓ | ✓ | 4 hooks |

---

## How it works

**Mining:** `gyst init` scans your codebase and git history to build a context layer — zero config, zero manual writing. It extracts conventions from your source files, decisions from commit messages and ADRs, error patterns from `TODO`/`FIXME` comments, and structural knowledge from the files your team touches most. The post-commit hook keeps it current automatically after every commit.

**Injection:** At every session start, Gyst injects your team's ghost knowledge and top conventions into the agent's context window. Subagents get the same injection. When a session ends, anything the agent learned gets distilled back into the context layer, so the next session starts even stronger.

---

## Learn more

- [Technical reference](docs/ADVANCED.md) — MCP tool API, CLI flags, hook system, search pipeline, configuration
- [3-minute demo script](docs/DEMO_SCRIPT.md) — step-by-step pitch walkthrough

---

## Dashboard

```bash
gyst dashboard   # opens at localhost:3579
```

Browse all context entries, inspect the knowledge graph, review low-confidence entries, and track context economics (leverage ratio, zero-result rate, intent mix).

---

## Team mode

### Git-sync (zero infrastructure)

The context layer lives in your repo. `git pull` syncs it automatically via the `post-merge` hook.

### Shared HTTP server

```bash
# Admin — set up once
gyst create team "Acme Engineering"
GYST_API_KEY=gyst_admin_... gyst team invite
gyst serve --http --port 3456

# Each developer — one command
gyst join gyst_invite_abc123... "Alice" --server http://your-host:3456
```

Every developer's AI tools automatically point at the shared context layer. Knowledge grows as the team grows.

---

## License

MIT — see [LICENSE](LICENSE).
