# Multi-Tool Hook Coverage Design

**Goal:** Extend gyst's lifecycle hook coverage beyond Claude Code to Gemini CLI, Cursor, Windsurf, and Codex CLI so every supported tool automatically injects KB context, harvests sessions, and triggers incremental mining.

---

## 1. Architecture

**Approach: Installer-driven per-tool hook configs**

The `gyst install` (via `installForDetectedTools`) already writes MCP server configs for detected tools. We extend it with a second pass: `installHooksForDetectedTools` writes each tool's hook config file using that tool's native format and event names.

Existing `plugin/scripts/*.js` are reused as-is — they already output `{"continue":true}` / `{"continue":false}` and use fire-and-forget detached spawns. Only the three scripts that parse stdin fields (`session-end.js`, `pre-tool.js`, `prompt.js`) need a thin normalizer, because each tool uses different field names for the same data.

**No new runtime dependencies.** No new npm packages. Hook configs are plain JSON files written at install time.

---

## 2. Supported Tools and Event Mapping

### 2.1 Gemini CLI

**Config:** `~/.gemini/settings.json` (merged into existing object)

**Format:**
```json
{
  "hooks": {
    "SessionStart": [{"type": "command", "command": "node /abs/path/session-start.js"}],
    "SessionEnd":   [{"type": "command", "command": "node /abs/path/session-end.js"}],
    "PreToolUse":   [{"type": "command", "command": "node /abs/path/pre-tool.js"}],
    "PostToolUse":  [{"type": "command", "command": "node /abs/path/tool-use.js"}]
  }
}
```

**Stdin shape (Gemini):**
```json
{
  "session_id": "abc123",
  "tool_name": "write_file",
  "tool_input": { ... },
  "tool_response": { ... }
}
```

Gemini uses the same field names as Claude Code (`session_id`, `tool_name`) — no normalization needed.

### 2.2 Cursor

**Config:** `~/.cursor/hooks.json` (user-level, written fresh; does not conflict with `.cursor/mcp.json`)

**Format:**
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{"type": "command", "command": "node /abs/path/session-start.js", "timeout": 5}],
    "sessionEnd":   [{"type": "command", "command": "node /abs/path/session-end.js",   "timeout": 5}],
    "preToolUse":   [{"type": "command", "command": "node /abs/path/pre-tool.js",      "timeout": 1}],
    "postToolUse":  [{"type": "command", "command": "node /abs/path/tool-use.js",      "timeout": 1}]
  }
}
```

**Stdin shape (Cursor):**
```json
{
  "sessionId": "abc123",
  "toolName": "edit_file",
  "toolInput": { ... },
  "toolOutput": { ... }
}
```

Cursor uses camelCase field names. `normalize-stdin.js` maps `sessionId` → `session_id`, `toolName` → `tool_name`.

### 2.3 Windsurf

**Config:** `~/.codeium/windsurf/hooks.json` (written fresh alongside existing `mcp_config.json`)

**Format:**
```json
{
  "hooks": {
    "pre_session":   [{"command": "node /abs/path/session-start.js"}],
    "post_session":  [{"command": "node /abs/path/session-end.js"}],
    "pre_tool_call": [{"command": "node /abs/path/pre-tool.js"}],
    "post_tool_call":[{"command": "node /abs/path/tool-use.js"}]
  }
}
```

**Stdin shape (Windsurf):**
```json
{
  "session_id": "abc123",
  "tool": "edit",
  "parameters": { ... },
  "result": { ... }
}
```

Windsurf uses `tool` (not `tool_name`). `normalize-stdin.js` maps `tool` → `tool_name`.

### 2.4 Codex CLI

**Config:** `~/.codex/hooks.json` (written fresh)

**Format:**
```json
{
  "hooks": {
    "SessionStart": [{"type": "command", "command": "node /abs/path/session-start.js"}],
    "SessionEnd":   [{"type": "command", "command": "node /abs/path/session-end.js"}],
    "PreToolUse":   [{"type": "command", "command": "node /abs/path/pre-tool.js"}],
    "PostToolUse":  [{"type": "command", "command": "node /abs/path/tool-use.js"}]
  }
}
```

**Stdin shape (Codex):**
```json
{
  "session_id": "abc123",
  "tool_name": "shell",
  "tool_input": { ... },
  "tool_response": { ... }
}
```

Codex mirrors Claude Code's field names — no normalization needed.

---

## 3. normalize-stdin.js

A shared ES module that normalizes stdin from any tool into a canonical shape before the existing scripts use it.

**Canonical shape:**
```js
{
  session_id: string | null,
  tool_name: string | null,
  transcript_path: string | null,
  prompt_text: string | null,
  stop_hook_active: boolean,
}
```

**Normalization rules:**
- `session_id`: try `session_id`, then `sessionId`
- `tool_name`: try `tool_name`, then `toolName`, then `tool`
- `transcript_path`: try `transcript_path`, then `transcriptPath`
- `prompt_text`: try `prompt`, then `prompt_text`, then `promptText`
- `stop_hook_active`: try `stop_hook_active` (boolean), default `false`

**Usage in scripts:**
```js
import { readNormalizedInput } from "./normalize-stdin.js";
const input = readNormalizedInput();
// input.session_id, input.tool_name — always correct regardless of tool
```

The three scripts that currently call `readFileSync(0, "utf8")` and access fields directly (`session-end.js`, `pre-tool.js`, `prompt.js`) switch to `readNormalizedInput()`.

---

## 4. Event-to-Script Mapping Summary

| gyst script | Claude Code event | Gemini event | Cursor event | Windsurf event | Codex event |
|---|---|---|---|---|---|
| `session-start.js` | `SessionStart` | `SessionStart` | `sessionStart` | `pre_session` | `SessionStart` |
| `session-end.js` | `Stop`, `SubagentStop` | `SessionEnd` | `sessionEnd` | `post_session` | `SessionEnd` |
| `pre-tool.js` | `PreToolUse` | `PreToolUse` | `preToolUse` | `pre_tool_call` | `PreToolUse` |
| `tool-use.js` | `PostToolUse` | `PostToolUse` | `postToolUse` | `post_tool_call` | `PostToolUse` |
| `pre-compact.js` | `PreCompact` | — | — | — | — |
| `post-compact.js` | `PostCompact` | — | — | — | — |
| `subagent-start.js` | `SubagentStart` | — | — | — | — |
| `prompt.js` | `UserPromptSubmit` | — | — | — | — |

PreCompact/PostCompact, SubagentStart, UserPromptSubmit are Claude Code-specific; the other tools have no equivalent events.

---

## 5. Installer Extension

`installHooksForDetectedTools(pluginScriptsDir: string): string[]`

- Detects each tool by checking the same parent directory existence logic already used for MCP configs
- Builds absolute paths to `plugin/scripts/*.js` from `pluginScriptsDir`
- Writes each tool's hook config using `writeJsonConfig()` (already exists)
- Returns list of tool names that received hook configs
- Errors are caught per-tool — one failure never blocks the others
- Logs a warning (never throws) if a config dir can't be written

The `gyst setup` / `gyst install` CLI command calls both `installForDetectedTools` (existing) and `installHooksForDetectedTools` (new) in sequence.

---

## 6. Files to Create / Modify

**Create:**
- `plugin/scripts/normalize-stdin.js` — stdin normalization adapter
- `plugin/hooks/gemini-hooks.json` — event→script mapping for documentation/reference
- `plugin/hooks/cursor-hooks.json` — same
- `plugin/hooks/windsurf-hooks.json` — same
- `plugin/hooks/codex-hooks.json` — same
- `tests/mcp/installer-hooks.test.ts` — tests for `installHooksForDetectedTools`
- `tests/plugin/normalize-stdin.test.js` — tests for normalization

**Modify:**
- `src/mcp/installer.ts` — add `installHooksForDetectedTools` + wire into `installForDetectedTools` (or call from CLI)
- `plugin/scripts/session-end.js` — use `readNormalizedInput()`
- `plugin/scripts/pre-tool.js` — use `readNormalizedInput()`
- `plugin/scripts/prompt.js` — use `readNormalizedInput()`
- `src/cli/index.ts` — call `installHooksForDetectedTools` in the `setup` and `install` commands

---

## 7. Error Handling

- Hook config write failure: log warning, continue. Never fail `gyst install`.
- `normalize-stdin.js` parse failure: return all-null canonical object. Scripts already handle null gracefully.
- Hook script runtime failure: already caught (`try { ... } catch { process.stdout.write({"continue":true}) }`).

---

## 8. Testing

- `installer-hooks.test.ts`: Given a temp dir tree mimicking each tool's home dir structure, `installHooksForDetectedTools` writes the correct JSON files with absolute paths.
- `normalize-stdin.test.js`: Each tool's stdin shape normalizes to the canonical shape. Missing fields → null. Unknown fields → ignored.

---

## 9. Out of Scope

- OpenCode — separate sub-project
- Windsurf "cascade" events (agent-specific, unstable API)
- Hook removal / uninstall
- PreCompact/PostCompact equivalents for non-Claude tools
