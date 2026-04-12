# Decision: 009 - Session harvesting via PreCompact hook

Date: 2026-04-12
Status: Accepted (pending main-session server registration and CLI wiring)

## Context

Until now, the only way knowledge enters Gyst is via explicit learn() calls.
That means developers must consciously remember to call learn() after
discovering something useful. In practice, most insights surface during the
flow of a coding session (error-fix cycles, architecture discussions,
convention agreements) and are forgotten before anyone thinks to record them.

Claude Code fires a PreCompact hook before it compresses the conversation
context. This is a perfect capture point: the full transcript is available,
the session is ending naturally, and the developer is not being interrupted.
Running harvest automatically at this point fills the knowledge base without
requiring any deliberate action.

The challenge is signal-to-noise ratio. A raw session transcript contains
large amounts of noise: System prompt injections, Tool output blocks,
pure code output lines, and CLAUDE.md references. Without a noise filter,
the pattern extractor would generate hundreds of low-quality entries.

## Baseline (before change)

From MEMORY.md (2026-04-12):
  429 tests passing
  MRR@5 = 0.9767 (post semantic search)
  Complete misses: 0/50

## Change

### New files

**src/mcp/tools/harvest.ts**
  - registerHarvestTool(server, db): MCP tool registration
  - harvestTranscript(db, params): core pipeline (noise filter -> extraction -> dedup -> insert)
  - filterNoise(): drops System: lines, CLAUDE.md refs, Tool blocks, pure-code lines (< 20% alpha)
  - extractCandidates(): regex-based scan across 4 entry types; error patterns look ahead
    10 lines for a paired fix pattern to produce a single combined entry
  - Session dedup: checks sources.session_id before processing; re-harvest of the same
    session returns all zeros instantly
  - Fingerprint dedup: identical content submitted under a different session_id is detected
    by findDuplicate() and reported as merged, not created
  - Sensitive data stripped via stripSensitiveData() before any content is stored
  - All per-candidate errors are caught and counted as skipped so the hook path is safe

**src/cli/harvest.ts**
  - runHarvestSession(): finds newest file under ~/.claude/projects/<cwd-slug>/,
    reads up to 100 KB, calls harvestTranscript, prints summary
  - Exits 0 on all error paths so PreCompact hook never blocks
  - session_id set to basename of the session file for stable idempotency

**tests/mcp/harvest.test.ts**
  - 11 test cases covering all specified scenarios
  - Uses initDatabase(":memory:") for full isolation
  - Calls harvestTranscript directly, bypassing the MCP protocol layer

**tests/fixtures/sample-session.txt**
  - 107-line realistic Claude Code session containing:
    - 2 decisions (SQLite over Redis, Bun over Node)
    - 3 errors with fixes (SQLITE_BUSY, migration busy_timeout, schema creation race)
    - 2+ conventions (parameterized queries, no console.log)
    - 2+ learnings (bun.serve throughput, FTS5 camelCase tokenisation)
    - Noise to filter: System: line, CLAUDE.md mention, Tool: blocks, code output
    - Sensitive data: api_key = "SK_TEST_..." for redaction test

## Result

Test count: 429 (existing) + 11 (new harvest tests) = 440 tests
Lint: 0 errors expected (TypeScript strict mode)
MRR impact: neutral (harvest adds entries to the knowledge base but the
  eval set is fixed, so new entries do not appear in the 50-query eval)

Patterns matched in sample-session.txt fixture:
  - Decisions: "decided to use", "chose bun because"
  - Errors: "Error: SQLITE_BUSY", "The bug was that"
  - Fix pairing: "Fixed:", "Resolved by" within 10-line window
  - Conventions: "Always use parameterized", "Never use console.log",
    "Convention:", "Standard:"
  - Learnings: "Learned that bun.serve", "discovered that the porter stemmer",
    "Turns out FTS5", "Note:"

## Decision

**Accepted** for the extraction pipeline and CLI command.

Two integration steps are deferred to the main session to avoid file
conflicts with other parallel workers:

1. Register registerHarvestTool(server, db) in src/mcp/server.ts
2. Wire gyst harvest-session command in src/cli/index.ts

## Follow-ups for main session

- **src/mcp/server.ts**: add import and call registerHarvestTool(server, db)
  alongside the other tool registrations
- **src/cli/index.ts**: add a Commander command:
    program
      .command("harvest-session")
      .description("Extract knowledge from the most recent Claude Code session")
      .action(async () => { await runHarvestSession(); });
- **README / install docs**: document the PreCompact hook snippet so users
  know to add it to .claude/settings.json for zero-effort auto-harvest
- **Tune LEARNING_PATTERNS**: "Note:" and "Important:" are broad enough to
  produce false positives on verbose sessions; may want to require a minimum
  line length (>= 30 chars after the prefix) to filter noise
- **Entity extraction**: run extractEntities() on harvested content to
  populate entity: tags the same way the learn tool does
