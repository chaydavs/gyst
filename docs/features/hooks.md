# Claude Code Hooks

## Overview

Gyst registers 12 Claude Code hook events in `plugin/hooks/hooks.json`. Hooks are Node.js scripts that Claude Code executes at specific points in the agent lifecycle. Every hook script reads JSON from stdin, does its work, and writes `{"continue": true}` to stdout.

The core design principle: **hooks must never block the agent**. All non-trivial work is dispatched as a fire-and-forget detached subprocess. The hook script itself returns in milliseconds.

---

## Architecture: Fire-and-Forget via `badge.js`

All hooks import from `plugin/scripts/badge.js`, which exports two utilities:

### `badge(action: string)`

Writes a compact ANSI status box to stderr:
```
┌─ gyst ──────────────────────┐
│ ◆ capturing tool use        │
└─────────────────────────────┘
```
This is the only user-visible signal that Gyst is active. It appears on stderr so it does not interfere with stdout (which carries the hook response JSON).

### `emitAsync(bin, eventType, payload)`

Spawns `gyst emit <eventType>` as a detached child process, writes the JSON payload to its stdin, calls `child.unref()`, and returns immediately. The child process continues running after the hook script exits.

```javascript
export function emitAsync(bin, eventType, payload) {
  const child = spawn(bin, ["emit", eventType], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  child.unref();
}
```

This pattern ensures that even if `gyst emit` takes several seconds to process an event (e.g., distilling a session transcript), the agent loop is never blocked.

---

## Hook Definitions (`plugin/hooks/hooks.json`)

```json
{ "event": "SessionStart",        "script": "plugin/scripts/session-start.js",       "timeout": 5000 }
{ "event": "UserPromptSubmit",    "script": "plugin/scripts/prompt.js",               "timeout": 500  }
{ "event": "InstructionsLoaded",  "script": "plugin/scripts/instructions-loaded.js",  "timeout": 500  }
{ "event": "PreToolUse",          "script": "plugin/scripts/pre-tool.js",             "timeout": 500  }
{ "event": "PostToolUse",         "script": "plugin/scripts/tool-use.js",             "timeout": 500  }
{ "event": "PostToolUseFailure",  "script": "plugin/scripts/tool-failure.js",         "timeout": 500  }
{ "event": "SubagentStart",       "script": "plugin/scripts/subagent-start.js",       "timeout": 2000 }
{ "event": "Stop",                "script": "plugin/scripts/session-end.js",          "timeout": 5000 }
{ "event": "SubagentStop",        "script": "plugin/scripts/session-end.js",          "timeout": 5000 }
{ "event": "PreCompact",          "script": "plugin/scripts/pre-compact.js",          "timeout": 5000 }
{ "event": "PostCompact",         "script": "plugin/scripts/post-compact.js",         "timeout": 2000 }
{ "event": "FileChanged",         "script": "plugin/scripts/file-changed.js",         "timeout": 500,
  "matcher": "**/*.md" }
```

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `SubagentStart` have an empty `matcher` string — they fire for every tool call.

---

## Hook Scripts

### `session-start.js` (SessionStart, 5s timeout)

Fires once when the agent session begins.

**What it does**:
1. Emits `session_start` event asynchronously (fire-and-forget)
2. Spawns `gyst self-document --skip-ghosts --no-llm` detached to refresh the structural/MD knowledge index
3. Runs `gyst inject-context --always-on --graph-traverse` **synchronously** (this is the one blocking call) to generate the context injection payload
4. Returns `{ continue: true, additionalContext: "<context>" }` — the `additionalContext` field is read by Claude Code and injected at the start of the agent's context window

The `inject-context` call is intentional blocking because `additionalContext` must be present in the hook response. The 5-second timeout is set to accommodate this.

### `prompt.js` (UserPromptSubmit, 500ms timeout)

Fires on every user message before the agent processes it.

**What it does**: Emits a `prompt` event asynchronously with `{ text, sessionId, cwd }`. The `gyst emit prompt` handler classifies the prompt's intent and type so downstream processing (harvest, knowledge classification) has signal about what kind of session is running.

No `additionalContext` is returned — this hook is purely observational.

### `instructions-loaded.js` (InstructionsLoaded, 500ms timeout)

Fires when Claude Code loads a memory file (CLAUDE.md, `~/.claude/CLAUDE.md`, etc.).

**What it does**: Emits `md_changed` asynchronously with the file path and `memoryType` (Project, User, etc.). The event triggers re-ingestion of the file into the `md_doc` corpus so CLAUDE.md changes are immediately reflected in the knowledge base.

### `pre-tool.js` (PreToolUse, 500ms timeout)

Fires before every tool call.

**What it does**:
1. Emits `pre_tool_use` with `{ tool, sessionId }` asynchronously
2. If the tool is `Read` and a `file_path` is present, also emits `kb_miss_signal` — this is a signal that the agent needed to read a source file, suggesting the KB is missing documentation for it
3. Displays the badge: `"watching <toolName>"`

Always returns `{ continue: true }` — never blocks or modifies any tool call.

### `tool-use.js` (PostToolUse, 500ms timeout)

Fires after every successful tool call.

**What it does** (two concurrent detached spawns):
1. Emits `tool_use` with `{ tool, sessionId, error }` — the `error` field captures any error text in the tool response for downstream error pattern extraction
2. If the tool was `Write` or `Edit` and the file is a `.md` file:
   - If the path matches `decisions/NNN-*.md` or `*/plans/*.md`: emits `plan_added` with full file content (up to 64KB)
   - Otherwise: emits `md_change` with the path only

Both emissions are concurrent — they are independent detached spawns that start at the same time.

### `tool-failure.js` (PostToolUseFailure, 500ms timeout)

Fires when a tool call returns an error.

**What it does**: Emits `tool_failure` with `{ error, toolName, sessionId, toolInput }` asynchronously. The `gyst emit tool_failure` handler attempts to extract an `error_pattern` entry from the error text using the normalize pipeline.

### `subagent-start.js` (SubagentStart, 2s timeout)

Fires when a subagent is spawned (e.g., via the `Task` tool).

**What it does**: Runs `gyst recall --type ghost_knowledge --limit 3 --format json` **synchronously** (using `execFileSync` with an argument array to avoid shell injection). If results are returned, formats them as a `## Team Knowledge (gyst)` markdown block and returns it as `additionalContext`.

This ensures every subagent starts with the team's hard constraints, even if it was spawned mid-session without the parent's context.

The `execFileSync` call (not `emitAsync`) is intentional here because the ghost context must be synchronously available for the `additionalContext` response field.

### `session-end.js` (Stop + SubagentStop, 5s timeout)

Used for both `Stop` (main agent session ending) and `SubagentStop` (subagent finishing).

**What it does**:
1. Emits `session_end` with `{ sessionId, reason }` asynchronously — triggers distillation of the session's events into knowledge entries
2. Spawns `gyst self-document --skip-ghosts --no-llm` detached to pick up any files changed during the session

### `pre-compact.js` (PreCompact, 5s timeout)

Fires before Claude Code compacts (summarizes) the context window to free up space.

**What it does**: Emits `session_end` with `reason: "pre_compact"` and the `transcriptPath` if available. This triggers a harvest pass before the transcript is discarded, preserving any knowledge that was in the portion being compacted.

### `post-compact.js` (PostCompact, 2s timeout)

Fires after context compaction completes.

**What it does**: Emits `drift_snapshot` with `reason: "post_compact_snapshot"`. The event handler calls `takeDriftSnapshot(db)` to record the current recall quality metrics. Post-compaction is a natural checkpoint for drift measurement — the context window has changed significantly.

### `file-changed.js` (FileChanged `**/*.md`, 500ms timeout)

Fires whenever a markdown file is saved. Matches only `.md` files via the `"**/*.md"` glob matcher.

**What it does**: Emits `md_changed` with `{ filePath, reason: "file_changed" }`. The handler re-ingests the file into the `md_doc` corpus immediately, so documentation changes are reflected in search results without waiting for the next `self-document` run.

---

## Hook Installation

Hooks are installed by `gyst install` (or `gyst setup`), which:

1. Reads `plugin/hooks/hooks.json`
2. Writes the hook configuration into the AI tool's config file:
   - Claude Code: `~/.claude/settings.json` under `hooks`
   - Cursor: `.cursor/rules`
   - Codex CLI: `.codex/hooks.json`
3. Sets `GYST_BIN` environment variable to the resolved path of the `gyst` binary

The `GYST_BIN` environment variable is used by all hook scripts to locate the binary. It defaults to `"gyst"` (PATH lookup) when the variable is not set.

---

## Timeout Policy

| Timeout | Used for |
|---------|---------|
| 500ms | Fast fire-and-forget hooks (prompt, pre-tool, post-tool, file-changed) |
| 2000ms | Subagent context injection (needs synchronous recall) |
| 5000ms | Session start/end and compaction (may run self-document synchronously) |

All hooks return within their timeout because the heavy work is always in detached subprocesses. The timeout applies to the hook script process itself, not the detached children it spawns.
