# Automated Context Construction — Design Spec

**Date:** 2026-04-19

---

## Problem

In AI-native companies the codebase is where all institutional knowledge lives — in commit messages, code comments, test descriptions, and file change patterns. Today that knowledge dies on the filesystem. A new developer (human or AI agent) has to read source files directly to answer questions that gyst should already know.

**Goal:** gyst mines the codebase automatically and keeps the KB rich without any human intervention, so every session starts with complete context.

---

## Signal Sources

| Source | What it encodes | Entry type |
|--------|----------------|------------|
| Git commit messages | Why things were built / changed | `decision`, `learning` |
| Code comments (`TODO`/`FIXME`/`NOTE`/`// Why:`) | Design intent, known issues, conventions | `convention`, `error_pattern` |
| Hot path files (most-edited) | Highest-value modules = core architecture | `ghost_knowledge` |
| Integration/e2e test top-level `describe()` | Expected system behaviour in business language | `convention` |

Tests are filtered aggressively: only `.integration.test.*` / `.e2e.test.*` / `.spec.*` files, only top-level `describe()` blocks, only names with 5+ words that don't contain implementation-detail language ("returns", "equals", "is true", "should be").

---

## New Command: `gyst mine`

```bash
gyst mine                    # all phases, incremental
gyst mine --commit HEAD      # mine a single commit only (post-commit hook path)
gyst mine --full             # full scan regardless of cursor (initial bootstrap)
gyst mine --no-llm           # skip Haiku summarization (default when no API key)
```

### Four internal phases

**Phase: git** — `git log --format="%H|%s|%b|%ai|%an" --no-merges` from `last_mined_hash` to HEAD. Skip commits whose subject matches `/^(chore|bump|merge|revert):/i`. For each remaining commit:
- Subject line → title
- Body text → content (raw, or Haiku-summarized if `ANTHROPIC_API_KEY` is set)
- Conventional commit type → entry type (`feat`/`refactor` → `decision`, `fix`/`perf` → `learning`)
- Hash-checked: skip if already stored

**Phase: comments** — `grep -rn` for `TODO|FIXME|NOTE|HACK|// Why:|# Why:` across `src/`, excluding `node_modules/`, `dist/`, `gyst-wiki/`, test fixture files. Group by file. Store each unique comment as a KB entry. Hash the comment text to skip duplicates.

**Phase: hotpaths** — `git log --format="" --name-only | sort | uniq -c | sort -rn | head 20`. For each hot file not already covered by a `ghost_knowledge` entry: generate a summary using the file's structural entry content + the last 5 commit messages touching it. Store as `ghost_knowledge` with `confidence = 0.9`.

**Phase: tests** — Glob `**/*.{integration,e2e,spec}.{test.,}{ts,js}`. For each file, regex-extract top-level `describe(` string arguments. Filter to names ≥ 5 words. Skip names containing: `returns`, `equals`, `is true`, `should be`, `called with`, `throws`. Store surviving names as `convention` entries.

### Cursor table

New table `codebase_mining_state` in `database.ts`:

```sql
CREATE TABLE IF NOT EXISTS codebase_mining_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Keys used:
- `last_commit_hash` — last SHA processed by git phase
- `last_comment_scan` — ISO timestamp of last comment scan
- `last_hotpath_scan` — ISO timestamp of last hot path scan
- `last_test_scan` — ISO timestamp of last test scan

---

## Autonomous Wiring

All triggers are fire-and-forget detached spawns. Zero latency added to the agent loop.

### Plugin hook changes

**`plugin/scripts/session-start.js`** — add after existing `self-document` spawn:
```js
const mine = spawn(gyst, ["mine", "--no-llm"], { detached: true, stdio: "ignore" });
mine.unref();
```

**`plugin/scripts/session-end.js`** — add after existing `harvest-session` spawn:
```js
const mine = spawn(gyst, ["mine", "--no-llm"], { detached: true, stdio: "ignore" });
mine.unref();
```

**`plugin/scripts/pre-compact.js`** — add `mine --no-llm` spawn alongside existing `harvest-session`.

### Git post-commit hook

**`src/capture/git-hook.ts`** — add `gyst mine --commit HEAD` as a detached spawn after the existing commit processing. This mines the just-landed commit's message immediately.

### Full autonomous loop

```
commit made       → post-commit hook → gyst mine --commit HEAD
session opens     → SessionStart     → gyst self-document + gyst mine --incremental
session ends      → Stop hook        → harvest-session + gyst mine --incremental
before compact    → PreCompact       → harvest-session + gyst mine --incremental
md file saved     → FileChanged      → existing md_changed pipeline (unchanged)
tool fails        → PostToolUseFailure → existing error_pattern pipeline (unchanged)
```

---

## README / Docs Updates

- Add "Automated Context Construction" section to README explaining the signal sources and triggers
- Update the Hooks table to show `mine` firing from `SessionStart`, `Stop`, `PreCompact`, and `post-commit`
- Update `gyst self-document` docs to distinguish it from `gyst mine` (structural vs. institutional knowledge)
- Update `plugin/WORKFLOW.md` with the new mine trigger points

---

## What does NOT change

- `gyst self-document` — unchanged, keeps its 4 phases (structural + MD)
- All existing hook scripts — only additive changes (new spawn added)
- All existing MCP tools — `recall()` automatically surfaces the new entry types
- DB schema — only the new `codebase_mining_state` table is added

---

## Out of scope

- PR/GitHub API mining (requires auth, V2)
- Slack/linear/issue tracker mining (V2)
- Real-time file watcher for source changes (only `.md` is watched today)
- Conflict resolution when two mining runs produce near-duplicate entries (handled by existing deduplication in consolidation pipeline)
