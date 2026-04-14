# Gyst

**Team knowledge compiler for AI coding agents.**

Every AI coding tool makes individual developers faster.
None of them make teams smarter. Your Claude Code doesn't know
what your teammate's Cursor learned yesterday. Gyst fixes that.

---

## Install

One command. Detects Claude Code, Cursor, Codex CLI, Gemini CLI, Windsurf, OpenCode, and Continue automatically.

```bash
npx gyst-mcp install
```

This runs the full setup: detects your AI tools → registers the MCP server → initializes your knowledge base → optionally scans for conventions → optionally captures team rules.

After install, every `gyst` command is available and your AI agents have 14 new tools via MCP.

---

## What it does

Every time a developer learns something — a bug fix, a deploy rule, a decision — their AI agent calls `learn()`. The knowledge is indexed into a shared SQLite database with full-text search, a relationship graph, and semantic embeddings. The next developer who hits the same situation — in any AI tool — calls `recall()` and gets it back.

```
Developer A (Claude Code) ──┐
Developer B (Cursor)       ──┤  learn() ──► Team Knowledge Base ──► recall()
Developer C (Codex CLI)    ──┤                                         │
Developer D (self-hosted)  ──┘                           every agent reads this
```

The knowledge base lives in your git repo (zero infrastructure) or on a shared HTTP server (team mode). Nothing leaves your infrastructure unless you choose otherwise.

---

## Features

### 14 MCP Tools

| Tool | Purpose |
|------|---------|
| `learn` | Record knowledge: errors, conventions, decisions, learnings |
| `recall` | Ranked search — returns full entries within a token budget |
| `search` | Compact index (id · type · confidence · age) — 7× more token-efficient |
| `get_entry` | Full markdown for one entry by ID — use after `search` |
| `conventions` | Coding standards for a file path or directory |
| `check_conventions` | Which conventions apply to a file |
| `check` | Run all violation detectors against a file |
| `failures` | Match a known error pattern by signature or keywords |
| `score` | Team knowledge uniformity score (0–100) |
| `graph` | Query the relationship graph (neighbors, shortest path, similar) |
| `feedback` | Rate an entry helpful/unhelpful — adjusts confidence ±0.02/0.05 |
| `harvest` | Extract knowledge from a session transcript |
| `activity` | Recent team activity log |
| `status` | Health check and database stats |

### Ghost Knowledge

The most important feature. Ghost knowledge entries have infinite confidence and always surface first — they encode things your team knows but never wrote down:

- "Don't deploy between 2–4pm, batch job runs"
- "The billing service must never be changed without Alice"
- "Express.json() breaks webhooks — use raw body parser"

```bash
gyst ghost-init   # interactive Q&A to capture tribal knowledge
```

Agents see ghost knowledge in every `recall()` regardless of what they're searching for.

### Convention Detection

```bash
gyst detect-conventions   # auto-scans your codebase
gyst check src/api/auth.ts  # enforce conventions against a file
```

Detects naming, imports, error handling, exports, testing style, file naming, and import ordering. Stored conventions become enforceable rules agents check before writing code.

### Progressive Disclosure

`recall()` returns full entries (expensive). `search()` returns a compact index at 1/7th the token cost. Use `search` to browse, then `get_entry(id)` for the ones that matter. Agents on small context windows (Ollama @ 4096 tokens) can pass `context_budget: 2000` to get compressed results automatically.

### Knowledge Graph

Every `learn()` call auto-links related entries by shared entities. Co-retrieved entries strengthen their connection over time. The graph becomes a map of what your team knows and how it's connected.

```bash
gyst dashboard   # D3 visualization of your knowledge graph at localhost:4242
```

---

## Natural Language Queries

Agents ask Gyst questions in plain English. The right tool fires automatically based on the description it reads.

| Agent question | Tool called |
|----------------|-------------|
| "What did we decide about error handling?" | `search` → `get_entry` |
| "What conventions does src/api/ follow?" | `conventions` |
| "Has anyone seen this Postgres error before?" | `failures` |
| "What should a new developer know?" | `onboard` |
| "What changed this week?" | `search` (temporal intent) |
| "Is this code following our conventions?" | `check` |

Each result includes a `ref: gyst://entry/{id}` citation URI agents can include in their responses.

---

## How it works

Five search strategies run in parallel on every query, fused with Reciprocal Rank Fusion:

1. **File path** — exact match on affected files (fastest)
2. **BM25 via FTS5** — keyword search with porter stemmer + code tokenization (camelCase → separate tokens)
3. **Graph traversal** — walk entity relationships from known nodes
4. **Temporal** — recency-weighted, boosted for debugging/history queries
5. **Semantic** — 22MB local ONNX model, no API call required

### Auto-injection at session start

The `install` command wires a `SessionStart` hook into Claude Code (and other tools that support hooks). At the start of every session, `gyst inject-context` runs automatically and injects:

- All ghost knowledge rules
- Top 3 conventions for the current directory
- Most recent error pattern

Your agents know your team's rules before you type the first message.

---

## Self-hosted LLMs

Gyst is designed for teams that don't want their knowledge leaving their infrastructure.

- **No external API calls.** The 22MB `all-MiniLM-L6-v2` model runs locally via `@xenova/transformers`. No OpenAI, no Anthropic, no Cohere.
- **No telemetry.** SQLite is local. The wiki lives in your git repo.
- **Works with Ollama, vLLM, LM Studio, OpenCode, Continue.** Any MCP-compatible client connects.
- **Adaptive context budget.** Self-hosted models with small context windows (4096 tokens) can request compressed output: `recall({query, context_budget: 2000})`.

---

## Team mode

**Git-sync (zero infrastructure):** The wiki lives in the repo. Everyone pulls the same knowledge via `git pull`. SQLite is local and gitignored. Works immediately with no server.

**Shared HTTP server (multi-developer real-time):**

```bash
# Admin
gyst team create "Acme Engineering"
gyst team invite   # prints an invite key

# Developer joins
gyst join <invite-key> "Alice"

# Start shared server
GYST_PORT=3000 bun run src/server/http.ts
```

MCP config for the shared server:

```json
{
  "mcpServers": {
    "gyst": {
      "type": "streamable-http",
      "url": "https://gyst.your-team.internal/mcp",
      "headers": { "Authorization": "Bearer gyst_member_..." }
    }
  }
}
```

All 14 tools are available over both stdio and HTTP transports.

---

## Benchmarks

All numbers are retrieval metrics, not end-to-end QA accuracy.

### Internal eval (50 code-specific queries)

| Metric | Score |
|--------|------:|
| MRR@5 | 0.977 |
| Recall@5 | 0.983 |
| NDCG@5 | 0.962 |

Hand-curated fixture of 50 queries across error patterns, conventions, decisions, and ghost knowledge. Used for per-PR regression testing — must not drop below 0.90.

### Collaborative eval (5-developer simulation, 30 queries)

MRR@5 = 0.967 — concurrent writes from 5 simulated developers, queries from a different developer than the one who learned.

### LongMemEval — session-level retrieval (500 questions)

| Metric | Score |
|--------|------:|
| Hit Rate @5 | **94.2%** |
| MRR@5 | 0.837 |
| Recall@5 | 0.868 |

**What this measures:** Was the correct session in the top-5 retrieved results? Measured against LongMemEval_s (Wu et al., ICLR 2025), 6-category cleaned split, 500 questions.

**What this does not measure:** End-to-end QA accuracy. Published competitor scores (Emergence AI 86%, Hindsight 91.4%) typically measure whether an LLM produced the correct text answer given the retrieved context — a harder task. Retrieval Hit@5 is an upper bound on QA accuracy; the actual QA number for Gyst is not yet measured and would be lower.

Best category: `single-session-assistant` 98.2%, `knowledge-update` 98.7%. Weakest: `single-session-user` 82.9%, `single-session-preference` 83.3%.

### CodeMemBench — team knowledge retrieval (200 queries, self-built)

| Metric | Score |
|--------|------:|
| NDCG@10 | 0.351 |
| Recall@10 | 0.677 |
| MRR@10 | 0.274 |
| Hit Rate | 78% |

**What this measures:** Can an agent find the right error pattern, convention, decision, or ghost rule for a real situation? 500 knowledge entries × 200 natural-language queries across 8 categories and 3 difficulty levels.

**Fairness note:** We built this benchmark. The dataset is committed at [`tests/benchmark/codememb/dataset.json`](tests/benchmark/codememb/dataset.json) — run your system against it.

**Ablation:** Semantic search carries this benchmark (disabling it drops hit rate from 78% to 10%). BM25 and graph contribute zero NDCG on natural-language paraphrased queries — different story on keyword queries. Full ablation in `benchmark-combined.json`.

Best category: `onboarding` NDCG=0.428, `convention_lookup` NDCG=0.390. Weakest: `error_resolution` NDCG=0.257, `temporal` NDCG=0.276.

### CoIR — code retrieval (4 of 10 subtasks, embedding-only)

| Subtask | NDCG@10 |
|---------|--------:|
| stackoverflow-qa | 0.840 |
| codefeedback-st | 0.660 |
| codefeedback-mt | 0.356 |
| cosqa | 0.327 |
| **subset mean** | **0.546** |

Model: `all-MiniLM-L6-v2` (22MB, same model used in production). **4 of 10 subtasks** — this mean is not directly comparable to the full CoIR leaderboard.

---

## Comparison

| | **Gyst** | claude-mem | mem0 | mcp-memory-service |
|---|---|---|---|---|
| Team sharing | ✓ | ✗ | ✓ (paid) | ✗ |
| Self-hosted, no API keys | ✓ | ✓ | paid tier | ✓ |
| Works with any MCP client | ✓ | ✓ | ✓ | ✓ |
| Ghost knowledge (always-on rules) | ✓ | ✗ | ✗ | ✗ |
| Convention detection + enforcement | ✓ | ✗ | ✗ | ✗ |
| Hybrid search (5 strategies) | ✓ | vector only | vector only | simple |
| Knowledge graph | ✓ | ✗ | ✗ | ✗ |
| Dashboard | ✓ | ✗ | ✗ | ✗ |
| MCP tools | 14 | 3 | varies | 1–2 |
| License | MIT | check | Apache 2.0 | check |

**Where competitors are better:**
- Augment Code has deeper IDE integration, PR review, and a polished cloud product. If you want zero infrastructure and a supported SaaS, use Augment.
- mem0 has a cloud service with zero-config setup. If you want managed infrastructure, use mem0.
- claude-mem is simpler for personal single-developer use with no team sharing needed.

**Gyst's moat:** open source + self-hosted + cross-tool + team-first + MIT license. No vendor lock-in, no data egress, works on air-gapped teams.

---

## CLI Commands

```
gyst install              # First-time setup (detects tools, registers MCP, initializes)
gyst serve                # Start MCP server (used by tool configs)
gyst setup                # Re-detect conventions from project
gyst ghost-init           # Capture tribal knowledge interactively
gyst detect-conventions   # Scan and store coding conventions
gyst check <file>         # Check file against stored conventions
gyst score                # Print uniformity score (0–100)
gyst onboard              # Generate onboarding markdown
gyst dashboard            # Start knowledge graph dashboard
gyst recall "query"       # Search from terminal
gyst team create <name>   # Create a team
gyst team invite          # Generate invite key
gyst join <key> <name>    # Join a team
```

---

## Architecture

```
gyst/
├── src/
│   ├── mcp/           # MCP server + 14 tools (stdio + HTTP)
│   ├── compiler/      # Extract, normalize, deduplicate, link, style-fingerprint
│   ├── store/         # SQLite + FTS5, 5-strategy search, RRF fusion, graph, confidence
│   ├── server/        # HTTP server, auth (API keys), activity logging, dashboard
│   ├── capture/       # Git hooks, session harvesting, context injection
│   ├── cli/           # Commander-based CLI (14 commands)
│   └── utils/         # Config, logger, errors, token counting
├── tests/             # 861 tests across 42 files
├── gyst-wiki/         # Compiled knowledge base (markdown files)
└── decisions/         # Architecture Decision Records (001–011)
```

**Tech stack:** Bun · TypeScript strict · SQLite via `bun:sqlite` with FTS5 · `@modelcontextprotocol/sdk` · Commander · Zod · `@xenova/transformers`

---

## Development

```bash
bun install
bun test                        # 861 tests, 42 files
bun run lint                    # TypeScript type check (tsc --noEmit)
bun run build                   # Bundle to dist/
bun run benchmark:codememb      # CodeMemBench (NDCG@10=0.351, Hit=78%)
bun run eval                    # Internal retrieval eval (MRR@5=0.977)
```

---

## Contributing

The highest-value contributions right now:

1. **QA evaluation mode** — run an LLM over the top-5 retrieved entries and score text answers. This produces the apples-to-apples number vs. other memory systems.
2. **CodeRankEmbed upgrade** — swap `all-MiniLM-L6-v2` for a code-specific embedding model to improve `error_resolution` and `temporal` categories.
3. **More tool integrations** — Zed, Neovim+avante.nvim, JetBrains.
4. **PostgreSQL backend** — for teams that need a real database server rather than SQLite.

File a GitHub issue before starting large changes. Decision records in `decisions/` explain non-obvious choices — read them before changing retrieval code.

---

## License

MIT — see [LICENSE](LICENSE).
