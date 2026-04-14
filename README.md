# Gyst

**Team knowledge layer for AI coding agents.** Extends Karpathy's LLM Wiki pattern for engineering teams. Served via MCP. Works with every AI coding tool.

> AI agents make every developer faster but no team smarter. Gyst fixes that.

## What it does

Every developer's AI agent (Claude Code, Cursor, Codex CLI, Gemini CLI, Cline, Windsurf, or self-hosted LLMs) reads from and writes to a shared knowledge base. The compiled wiki accumulates what your entire engineering org learns through AI-assisted development: what failed, what worked, what patterns your team follows, what decisions were made and why.

```
Developer A (Claude Code) --+
Developer B (Cursor)     --+
Developer C (Codex CLI)  --+--> MCP Server --> Team Wiki
Developer D (Self-hosted  --+
             Llama)       --+
```

## Quick Start

```bash
# Install
bun add gyst

# Initialize in your project
gyst setup

# Your AI agent now has access to team knowledge via MCP tools:
#   learn   - Record knowledge (error patterns, conventions, decisions)
#   recall  - Search team knowledge base
#   conventions - Get coding standards for current context
#   failures    - Check if an error has been seen before
#   activity    - See recent team activity
#   status      - See who's active and what they're working on
```

## How It Works

### Knowledge Types
- **Error patterns** - Bugs your team has encountered and how to fix them
- **Conventions** - Team coding standards (naming, error handling, test structure)
- **Decisions** - Architectural decisions and their rationale
- **Learnings** - General insights from development sessions

### Search Architecture
Three strategies run in parallel, fused with Reciprocal Rank Fusion:
1. **File path lookup** - Exact match on affected files
2. **BM25 via FTS5** - Full-text search with code-aware tokenization
3. **Graph traversal** - Walk relationships between entries

### Confidence & Decay
Every entry has a confidence score (0-1) based on source count, recency, and type-specific temporal decay:
- Error patterns: 30-day half-life (patches fix root causes)
- Conventions: No decay (stable until explicitly changed)
- Decisions: 365-day half-life (architecture is long-lived)
- Learnings: 60-day half-life

### Personal vs Team Knowledge
- **Personal** scope: Only visible to you (default for learnings)
- **Team** scope: Visible to everyone (default for errors, conventions, decisions)
- **Project** scope: Visible to everyone in the same repo

## Team Collaboration

### Mode 1: Git-sync (zero infrastructure)
Wiki lives in the repo. Everyone pulls the same wiki via git. SQLite is local and gitignored.

```bash
gyst setup          # Initialize wiki + database
gyst rebuild        # Rebuild index from markdown files after git pull
```

### Mode 2: Shared HTTP server
Multiple developers connect to one Gyst server via MCP over Streamable HTTP.

```bash
# Admin creates a team
gyst team create "My Team"
# Share the invite key
gyst team invite
# Developer joins
gyst join <invite-key> "Alice"

# Start the shared server
GYST_PORT=3000 bun run src/server/http.ts
```

MCP config for shared server:
```json
{
  "mcpServers": {
    "gyst": {
      "type": "streamable-http",
      "url": "https://gyst.your-company.internal/mcp",
      "headers": {
        "Authorization": "Bearer gyst_member_..."
      }
    }
  }
}
```

## MCP Tools (14)

| Tool | Purpose |
|------|---------|
| `learn` | Record knowledge with entity extraction, style fingerprint, auto-linking |
| `recall` | Ranked search with RRF fusion, intent boost, ghost tier 0 |
| `search` | Compact index (id/type/confidence/title) for progressive disclosure |
| `get_entry` | Full markdown for a single entry |
| `conventions` | List coding standards by directory/tags |
| `check_conventions` | Check a file against stored conventions |
| `failures` | Match known error patterns |
| `check` | Run all violation detectors against a file |
| `score` | Uniformity score for the codebase |
| `graph` | Query the relationship graph |
| `feedback` | Rate an entry helpful/unhelpful (adjusts confidence ±0.02/0.05) |
| `harvest` | Extract knowledge from a session transcript |
| `activity` | Query team activity log |
| `status` | Health check / stats |

## CLI Commands

```
gyst setup                    # Detect conventions from project
gyst ghost-init               # Create ghost knowledge entries
gyst onboard                  # Generate onboarding document
gyst score                    # Print uniformity score
gyst detect-conventions       # Run convention detectors
gyst check <file>             # Check file for violations
gyst dashboard                # Start dashboard server
gyst recall "query"           # Search knowledge from terminal
```

## Benchmarks (CodeMemBench, April 2026)

| Metric | Score |
|--------|-------|
| NDCG@10 | 0.351 |
| Recall@10 | 0.677 |
| MRR@10 | 0.274 |
| Hit Rate | 78% |
| Convention hit | 92% |
| Ghost knowledge hit | 76% |
| Onboarding hit | 84% |

## Architecture

```
gyst/
├── src/
│   ├── mcp/           # MCP server + 14 tools (stdio + HTTP)
│   ├── compiler/      # Extract, normalize, deduplicate, link, style-fingerprint, security
│   ├── store/         # SQLite + FTS5, 5-strategy search, RRF fusion, confidence, graph
│   ├── server/        # HTTP server, auth (API keys), activity logging, dashboard
│   ├── capture/       # Git hooks (post-commit, post-merge), manual entry
│   ├── cli/           # Commander-based CLI (7 commands)
│   └── utils/         # Config, logger, errors, token counting
├── tests/             # 842 tests across 41 files
├── gyst-wiki/         # Compiled knowledge base (markdown files)
└── decisions/         # Architecture Decision Records
```

## Tech Stack

- **Runtime**: Bun (built-in SQLite, native TypeScript)
- **MCP**: @modelcontextprotocol/sdk
- **Database**: SQLite via bun:sqlite with FTS5
- **Search**: 5-strategy (BM25, file-path, graph, temporal, vector) + RRF
- **Auth**: API keys with bcrypt hashing
- **CLI**: Commander

## Development

```bash
bun install                   # Install dependencies
bun test                      # Run 842 tests across 41 files
bun run lint                  # Type check (tsc --noEmit)
bun run benchmark:codememb    # CodeMemBench evaluation
bun run dev                   # Start MCP server in dev mode
```

## Self-Hosted

Everything runs on your infrastructure. No external API calls, no telemetry. The entire stack is self-contained:
- MCP server runs locally (stdio) or on internal network (HTTP)
- Wiki lives in your git repo
- SQLite database is local
- Works with self-hosted LLMs (Llama, Mistral, DeepSeek, Qwen) via any MCP-compatible client

## License

MIT
