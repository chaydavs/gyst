# Gyst Plugin — How It Works

This document explains how the Gyst Claude Code plugin fires, what each hook does, and how the plugin recognizes and learns your codebase automatically.

---

## Overview

The plugin is a set of Node.js scripts wired to 12 Claude Code lifecycle hooks. Each script runs in milliseconds (hooks are fire-and-forget), calls the `gyst` CLI, and always returns `{ "continue": true }` so the agent loop is never blocked.

```
Claude Code lifecycle
      │
      ├─ SessionStart ────────► inject team context + self-document (detached)
      ├─ UserPromptSubmit ────► first prompt: inject task context; subsequent: record prompt event
      ├─ InstructionsLoaded ──► ingest CLAUDE.md
      ├─ PreToolUse ──────────► status badge
      ├─ PostToolUse ─────────► capture tool event; detect ADR/plan writes
      ├─ PostToolUseFailure ──► extract error_pattern entry
      ├─ SubagentStart ───────► inject ghost knowledge into subagent
      ├─ Stop ────────────────► distill session + self-document (detached)
      ├─ SubagentStop ────────► same distillation for subagent sessions
      ├─ PreCompact ──────────► harvest knowledge before context erased
      ├─ PostCompact ─────────► drift snapshot
      └─ FileChanged (**/*.md)► re-ingest changed markdown immediately
```

---

## Codebase Recognition — How It Works

When you open a project, the plugin automatically builds (or refreshes) a structural map of the codebase via three mechanisms:

### 1. Session-start self-document (every session)

`scripts/session-start.js` spawns `gyst self-document --skip-ghosts --no-llm` as a detached background process every time a session opens:

```js
const selfDoc = spawn(gyst, ["self-document", "--skip-ghosts", "--no-llm"], {
  detached: true,
  stdio: "ignore",
});
selfDoc.unref();  // never blocks session startup
```

`gyst self-document` runs three phases:

| Phase | What it does | LLM calls |
|-------|-------------|:---------:|
| **Phase 1 — Structural skeleton** | Globs all `.ts`/`.js` source files, extracts exports and imports per file, stores each as a `structural` entry. Hash-checked — unchanged files are skipped. | 0 |
| **Phase 2 — MD corpus** | Scans all `**/*.md` files (specs, plans, ADRs, CLAUDE.md). Parses frontmatter for title/tags; extracts section headings as a TOC prefix for better BM25 recall. Hash-checked. | 0 |
| **Phase 3 — Link graph edges** | Bulk SQL JOIN: structural ↔ md_doc by shared file path, md_doc ↔ md_doc by directory proximity, curated entries by shared tags (capped at 8 per tag group). Creates relationship edges so the knowledge graph has real topology. | 0 |

Ghost knowledge (Phase 4) is only generated when an `ANTHROPIC_API_KEY` is present and `--skip-ghosts` is not passed. The session-start path always uses `--no-llm` to keep startup fast.

### 2. InstructionsLoaded — CLAUDE.md ingestion

When Claude Code loads `CLAUDE.md` (or any instructions file), `scripts/instructions-loaded.js` fires and emits `instructions_loaded` to the gyst event processor. The compiler extracts conventions, decisions, and patterns from the file and stores them as KB entries. This happens automatically whenever you create or update a `CLAUDE.md`.

### 3. FileChanged — live markdown sync

The `FileChanged` hook is matched against `**/*.md`. Every time you save a markdown file, `scripts/file-changed.js` fires and calls:

```
gyst emit md_changed --path <file>
```

The event processor re-ingests the file immediately — updated content is in the KB before the agent's next tool call.

---

## Hook-by-Hook Reference

### `SessionStart` — `scripts/session-start.js`

**Fires:** When a new Claude Code session opens.

**What it does:**
1. Emits `session_start` event (fire-and-forget).
2. Spawns `gyst self-document --skip-ghosts --no-llm` detached — refreshes the KB from the codebase in the background.
3. Runs `gyst inject-context --always-on --graph-traverse` synchronously and returns its output as `additionalContext`.

**`additionalContext`** is prepended to the agent's system context. It contains:
- Ghost knowledge entries (confidence 1.0 — always injected)
- Top conventions for the current working directory
- Recent team activity summary
- Drift warning if score > 0.4

The agent reads this before responding to the first user message. No recall() call needed — context is already there.

---

### `UserPromptSubmit` — `scripts/prompt.js`

**Fires:** Every time the user submits a prompt.

**What it does (two-phase behavior):**

**First prompt of a session** — performs active context injection:
1. Checks for a flag file at `tmpdir()/.gyst-sessions/{sessionId}-injected`. If it does not exist, this is the first prompt.
2. Writes the flag file immediately (prevents infinite retry if the script crashes mid-run).
3. Runs `gyst recall <promptText> -n 3 --format json` synchronously (1500ms timeout, cwd set to project root).
4. If results are returned, formats them as a `## Task-Relevant Context (from gyst)` markdown block and returns it as `additionalContext` — Claude Code injects this before the agent responds.
5. Falls through silently on any error (recall failure, empty results, timeout) — always returns `{ continue: true }`.

**Subsequent prompts** — purely observational:
- Emits `user_prompt` with the prompt text as a fire-and-forget async event.
- The classifier buckets the intent (temporal / debugging / code_quality / conceptual) and stores it in `usage_metrics` for the Context Economics dashboard.
- No `additionalContext` is returned.

**Flag file lifecycle:**
- Written on first prompt (both success and failure paths)
- Opportunistic 24h cleanup: any flag file older than 24h is deleted at the start of each hook invocation
- Deleted on `session_end` via the Stop hook

**Timeout:** 2000ms (hook timeout). The synchronous recall call uses a 1500ms internal timeout, leaving 500ms margin for process startup and flag file I/O.

---

### `InstructionsLoaded` — `scripts/instructions-loaded.js`

**Fires:** When Claude Code loads a `CLAUDE.md` or instructions file.

**What it does:** Emits `instructions_loaded` with the file path. The compiler ingests the file into the KB — extracting conventions, decisions, and patterns from its content.

---

### `PreToolUse` — `scripts/pre-tool.js`

**Fires:** Before every tool call.

**What it does:**
- Writes a status badge to stderr: `[gyst] ready` — visible in the Claude Code status line.
- Emits `pre_tool_use` with the tool name and input.
- Tracks `Read` tool calls as KB miss signals (if the agent is reading source code for information, the KB may have a gap).

---

### `PostToolUse` — `scripts/tool-use.js`

**Fires:** After every successful tool call.

**What it does:**
1. Emits `tool_use` with tool name, session ID, and any error text — fires concurrently.
2. Detects markdown writes: if the tool is `Write` or `Edit` and the file path ends in `.md`:
   - `decisions/*.md` or `docs/**/plans/*.md` → emits `plan_added` with the file content (auto-ingests ADRs and plan documents).
   - Other `.md` → emits `md_change` (path only, picked up by the file-changed pipeline).

Both emissions use detached spawns — they run after the hook returns.

---

### `PostToolUseFailure` — `scripts/tool-failure.js`

**Fires:** When a tool call returns an error.

**What it does:** Emits `tool_failure` with the tool name, error message, and session ID. The compiler normalizes the error signature (strips paths, line numbers, UUIDs) and stores it as an `error_pattern` entry. Future sessions see this error pattern automatically via `recall()` and `failures()`.

---

### `SubagentStart` — `scripts/subagent-start.js`

**Fires:** When Claude Code spawns a subagent.

**What it does:** Runs `gyst inject-context` and returns the output as `additionalContext` for the subagent — same ghost knowledge + conventions that the parent session received. Subagents start with full team context.

---

### `Stop` — `scripts/session-end.js`

**Fires:** When the session ends (user closes Claude Code or the session stops).

**What it does:**
1. Emits `session_end` — triggers session distillation: the compiler re-processes the session's events and promotes high-signal learnings to KB entries.
2. Spawns `gyst self-document --skip-ghosts --no-llm` detached — ensures the KB reflects any files changed during the session.

---

### `SubagentStop` — `scripts/session-end.js`

**Fires:** When a subagent session ends.

**What it does:** Identical to `Stop` — distillation + KB refresh for the subagent's session context.

---

### `PreCompact` — `scripts/pre-compact.js`

**Fires:** Before Claude Code compacts (summarizes) the conversation context.

**What it does:** Runs `gyst harvest` against the current session transcript before the context is erased. Any knowledge in the about-to-be-compacted messages is extracted and stored in the KB first. This is the safety net: nothing is lost when the context window fills.

---

### `PostCompact` — `scripts/post-compact.js`

**Fires:** After compaction completes.

**What it does:** Takes a drift snapshot — records the current zero-result rate, average results per recall, and recall/learn ratio into `drift_snapshots`. The Dashboard's Drift Detection section uses these snapshots to compute the 7-day vs 30-day trend.

---

### `FileChanged (**/*.md)` — `scripts/file-changed.js`

**Fires:** When any `.md` file changes on disk.

**What it does:** Emits `md_changed` with the file path. The compiler re-ingests the file immediately — updated specs, plans, ADRs, and documentation are in the KB before the next agent turn.

---

## Autonomous Mining Loop

`gyst mine` fires automatically at all trigger points:

| Trigger | Command |
|---------|---------|
| `git commit` → post-commit hook | `gyst mine --commit HEAD --no-llm` |
| Session opens → SessionStart | `gyst mine --no-llm` |
| Session ends → Stop | `gyst mine --no-llm` |
| Before compact → PreCompact | `gyst mine --no-llm` |

All spawns are detached and unref'd — fire-and-forget, zero latency added to the agent loop.

Mining extracts from four sources: git commit history, `TODO`/`FIXME`/`NOTE`/`HACK` code comments, the top-20 most-edited files (stored as `ghost_knowledge`), and top-level `describe()` names from integration/e2e test files.

---

## Event → KB Pipeline

All hook scripts call `gyst emit <event> <payload>` (via the `emitAsync` helper in `badge.js`). The event flows through the gyst CLI into the compiler:

```
hook script
  └─ gyst emit <event> <json>
       └─ src/store/events.ts   — append to events table
            └─ src/compiler/process-events.ts  — classify + extract
                 └─ src/compiler/extract.ts     — structured facts
                      └─ src/store/database.ts  — write to entries / relationships
```

The `process-events` step runs in the background after the hook returns. The agent never waits for it.

---

## Fire-and-Forget Pattern

Every emission that doesn't need to return data uses the same pattern:

```js
// badge.js — shared helper
export function emitAsync(gyst, event, payload) {
  const child = spawn(gyst, ["emit", event, JSON.stringify(payload)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
```

`child.unref()` releases the Node.js event loop reference — the hook process exits immediately without waiting for `gyst emit` to finish. Latency added to the agent loop: < 1ms.

---

## Plugin Structure

```
plugin/
├── plugin.json          # Manifest: hook registrations, metadata, tier gate
└── scripts/
    ├── badge.js          # Shared: status badge + emitAsync helper
    ├── session-start.js  # SessionStart: inject context + self-document
    ├── prompt.js         # UserPromptSubmit: record intent
    ├── instructions-loaded.js  # InstructionsLoaded: ingest CLAUDE.md
    ├── pre-tool.js       # PreToolUse: status badge
    ├── tool-use.js       # PostToolUse: capture tool event + ADR detection
    ├── tool-failure.js   # PostToolUseFailure: extract error_pattern
    ├── subagent-start.js # SubagentStart: inject context into subagents
    ├── session-end.js    # Stop + SubagentStop: distill + self-document
    ├── pre-compact.js    # PreCompact: harvest before context erased
    ├── post-compact.js   # PostCompact: drift snapshot
    └── file-changed.js   # FileChanged: re-ingest changed markdown
```

---

## Multi-Tool Hook Coverage

`gyst install` writes native hook configs for every AI coding tool it detects on the machine. The same KB injection, session harvesting, and mine triggers that fire under Claude Code also fire under:

| Tool | Detection | Hook config |
|------|-----------|-------------|
| Gemini CLI | `~/.gemini/` exists | `~/.gemini/settings.json` |
| Cursor | `~/.cursor/` exists | `~/.cursor/hooks.json` |
| Windsurf | `~/.codeium/windsurf/` exists | `~/.codeium/windsurf/hooks.json` |
| Codex CLI | `~/.codex/` exists | `~/.codex/hooks.json` |

Each tool's hook config maps its native event names to the same `plugin/scripts/*.js` files. A shared `normalize-stdin.js` normalizes each tool's stdin field names (`sessionId` vs `session_id`, `tool` vs `tool_name`, etc.) so scripts work correctly regardless of which tool invokes them.

PreCompact, PostCompact, SubagentStart, and UserPromptSubmit hooks remain Claude Code-only — those tools have no equivalent events.

---

## Requirements

- **Bun** ≥ 1.0.0 — the `gyst` CLI is a Bun binary
- **gyst-mcp** installed and on `PATH` — plugin scripts call `gyst` directly
- **Claude Code** — plugin hooks are Claude Code–specific; MCP tools (`recall`, `learn`, etc.) work in any MCP-compatible host
- **Tier: team** — the plugin is gated to team subscribers; solo users get the MCP server and CLI only
