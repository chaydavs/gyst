# Gyst

## Project Identity
Building a universal team knowledge layer for AI coding agents.
Extends Karpathy's LLM Wiki pattern for teams. Served via MCP.
Works with Claude Code, Cursor, Codex CLI, Gemini CLI, Cline, Windsurf, and self-hosted LLMs.

One-liner: AI agents make every developer faster but no team smarter. We fix that.

## Tech Stack — DO NOT CHANGE without documenting a decision in decisions/
- Runtime: Bun (built-in SQLite, native TypeScript, fast startup)
- Language: TypeScript strict mode
- MCP: @modelcontextprotocol/sdk
- Database: SQLite via bun:sqlite with FTS5
- Git: simple-git
- Diff: parse-git-diff
- Markdown: gray-matter
- CLI: commander
- Validation: zod
- Tests: bun test

## Project Structure
```
gyst/
├── src/
│   ├── mcp/
│   │   ├── server.ts           # MCP server entry point (stdio transport)
│   │   ├── tools/
│   │   │   ├── learn.ts        # Record team knowledge
│   │   │   ├── recall.ts       # Search team knowledge
│   │   │   ├── conventions.ts  # Get team coding standards
│   │   │   └── failures.ts     # Check for known error patterns
│   │   └── installer.ts        # Auto-detect tools and write MCP config
│   ├── compiler/
│   │   ├── extract.ts          # Pull structured facts from raw input
│   │   ├── normalize.ts        # Error signature normalization
│   │   ├── deduplicate.ts      # Find and merge duplicate entries
│   │   ├── linker.ts           # Build relationships between entries
│   │   ├── writer.ts           # Write compiled markdown files
│   │   └── security.ts         # Strip sensitive data before storage
│   ├── store/
│   │   ├── database.ts         # SQLite setup, schema, migrations
│   │   ├── search.ts           # BM25, file path lookup, graph traversal, RRF fusion
│   │   ├── confidence.ts       # Scoring, decay, and archival
│   │   └── sync.ts             # Turso team sync (V2, do not build yet)
│   ├── capture/
│   │   ├── git-hook.ts         # Post-commit hook handler
│   │   └── manual.ts           # CLI manual entry handler
│   ├── slack/                  # V2, do not build yet
│   │   ├── bot.ts
│   │   ├── commands.ts
│   │   └── notifications.ts
│   ├── cli/
│   │   └── index.ts            # CLI entry point (gyst command)
│   └── utils/
│       ├── config.ts           # Load .gyst-wiki.json config
│       ├── logger.ts           # Structured logging, never console.log
│       ├── tokens.ts           # Token counting for context budget
│       └── errors.ts           # Custom error types
├── tests/                      # Mirrors src/ structure
├── gyst-wiki/                  # Output: the compiled knowledge base
├── decisions/                  # ADRs: what we tried and why
├── scripts/
│   └── install-hooks.sh
├── CLAUDE.md                   # This file
├── package.json
└── tsconfig.json
```

## Current Phase: V1 (Complete)

### MCP Tools (13 total — both stdio and HTTP transports)
- `learn` — record team knowledge with entity extraction, auto-linking
- `recall` — ranked search with RRF fusion, intent boost, ghost_knowledge tier 0
- `search` — compact index (id/type/confidence/title) for progressive disclosure
- `get_entry` — full markdown for a single entry by ID
- `conventions` — list coding standards by directory/tags
- `check_conventions` — check a file against stored conventions
- `failures` — match known error patterns by signature or BM25
- `check` — run all violation detectors against a file
- `graph` — query the relationship graph (neighbors, path, similar)
- `feedback` — rate an entry helpful/unhelpful (adjusts confidence ±0.02/0.05)
- `harvest` — extract knowledge from a session transcript
- `activity` — query team activity log
- `status` — health check / stats

### CLI Commands
- `gyst setup` — detect conventions from a sample project
- `gyst ghost-init` — create ghost knowledge entries interactively
- `gyst onboard` — generate onboarding document for new developers
- `gyst detect-conventions` — run convention detectors and print results
- `gyst check <file>` — check a file for convention violations
- `gyst export` — export all active knowledge entries to markdown files (derived from DB)
- `gyst dashboard` — start the dashboard HTTP server

DO NOT build yet:
- Slack bot (V2)
- Turso team sync (V2)
- Dashboard enhancement (V3)
- Docker deployment (V3)

## Code Rules
- async/await everywhere, no callbacks
- All functions return typed results
- Wrap external calls in try/catch with custom error types
- Use src/utils/logger.ts for all logging, NEVER console.log
- File names: kebab-case. Classes: PascalCase. Functions: camelCase
- Every public function gets a JSDoc comment explaining WHAT and WHY
- No `any` types. If you need flexibility, use `unknown` with type guards
- Tests required for: search, confidence, normalization, deduplication

## Architecture Rules
- MCP server is the ONLY agent interface to the knowledge base
- SQLite is the source of truth. Markdown files are a derived export (autoExport config or gyst export command).
- If SQLite is deleted, use `gyst export` after restoring a DB backup, or run `gyst rebuild` to migrate legacy markdown.
- Never store raw source code in entries — store descriptions and patterns
- Recall responses: max 5000 tokens. Hard limit, not suggestion
- Confidence scores: always between 0.0 and 1.0
- Entries below 0.15 confidence are excluded from recall results
- All database writes use transactions
- All user input is validated with zod before processing

## Error Normalization Rules
When normalizing error signatures for matching:
1. Replace file paths with <PATH>
2. Replace line:col references with <LINE>
3. Replace UUIDs with <UUID>
4. Replace timestamps with <TS>
5. Replace URLs with <URL>
6. Replace quoted strings with <STR>
7. Replace numbers with <N> (do this LAST)
8. Lowercase everything
Order matters. More specific patterns first, numbers last.

## Search Strategy
Five strategies run in parallel, fused with Reciprocal Rank Fusion (k=60):
1. File path lookup — exact match on affected files, fastest
2. BM25 via FTS5 — keyword search with porter stemmer + query expansion
3. Graph traversal — walk relationships from known entities
4. Temporal — recency-weighted results for debugging/history intents
5. Vector (semantic) — requires custom SQLite with sqlite-vec extension
Pre-process all text with codeTokenize() before FTS5 insertion:
- Split camelCase: getUserName → get user name
- Split snake_case: get_user_name → get user name
- Split dots: this.auth → this auth
- Lowercase
Ghost knowledge entries get a +0.15 RRF boost and always surface in tier 0.
Co-retrieval is recorded after every search; 3+ co-retrievals auto-creates a
relationship edge (processed during consolidation Stage 2.5).

## Confidence Decay Half-Lives
- error_pattern: 30 days
- convention: no decay (stable until explicitly changed)
- decision: 365 days
- learning: 60 days

## Security: NEVER Store
- API keys, tokens, passwords, certificates
- Environment variable values
- Raw source code (store patterns and descriptions instead)
- PII beyond developer names for attribution
- Connection strings
- JWT tokens
Run security.ts stripSensitiveData() on ALL content before storage.

## Build Commands
- `bun run dev` — Start MCP server in dev mode
- `bun run build` — Compile to dist/
- `bun test` — Run all tests (895 tests, 47 files)
- `bun run setup` — First-time setup
- `bun run install-hooks` — Install git hooks
- `bun run lint` — TypeScript type check (tsc --noEmit)
- `bun run benchmark:codememb` — Run CodeMemBench (NDCG@10=0.327, Hit=66%)

## Benchmarks (CodeMemBench, April 2026)
NDCG@10: 0.3269 | Recall@10: 0.6008 | MRR@10: 0.2555 | Hit Rate: 66.0%
ghost_knowledge hit: 92.0% | convention hit: 64% | onboarding hit: 84%

## Decision Log
When making a significant technical choice, create a file in decisions/:
decisions/NNN-short-title.md with: Context, Options, Decision, Outcome.
Check existing decisions before making new ones that might conflict.

## Memory
Check .claude/memory/ at the start of every session for:
- MEMORY.md — current project state, blockers, what works, what doesn't
- architecture.md — data flow, schema notes
- debugging.md — known issues and fixes

## Git Rules
- NEVER run `git diff` without a specific file path. Use `git diff --stat` first.
- NEVER run `git log` without `--oneline -10` limit.
- ALWAYS run `git status --short` instead of `git status`.
- Before any git operation that might produce large output, estimate the output size and ask me first.
