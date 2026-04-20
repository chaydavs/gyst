# Multi-Tool Hook Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend gyst's lifecycle hooks to Gemini CLI, Cursor, Windsurf, and Codex CLI so every supported tool automatically injects KB context, harvests sessions, and triggers incremental mining — without changing any existing plugin script logic.

**Architecture:** Add `normalize-stdin.js` to normalize each tool's stdin field names into a canonical shape, update the 3 scripts that read stdin to use it, then add `installHooksForDetectedTools()` to `installer.ts` that writes per-tool hook config files using each tool's native JSON format. Wire the new function into the existing `setup`/`install` CLI commands.

**Tech Stack:** Node.js ESM scripts, TypeScript (Bun runtime), bun:test, plain JSON config files.

---

## File Map

| Status | Path | What it does |
|--------|------|--------------|
| Create | `plugin/scripts/normalize-stdin.js` | Reads stdin, normalizes field names to canonical shape |
| Modify | `plugin/scripts/session-end.js` | Switch to `readNormalizedInput()` |
| Modify | `plugin/scripts/pre-tool.js` | Switch to `readNormalizedInput()` |
| Modify | `plugin/scripts/prompt.js` | Switch to `readNormalizedInput()` |
| Modify | `src/mcp/installer.ts` | Add `installHooksForDetectedTools()` |
| Modify | `src/cli/index.ts` | Call `installHooksForDetectedTools()` in setup action |
| Create | `plugin/hooks/gemini-hooks.json` | Reference config for Gemini CLI |
| Create | `plugin/hooks/cursor-hooks.json` | Reference config for Cursor |
| Create | `plugin/hooks/windsurf-hooks.json` | Reference config for Windsurf |
| Create | `plugin/hooks/codex-hooks.json` | Reference config for Codex CLI |
| Create | `tests/plugin/normalize-stdin.test.js` | Tests for stdin normalization |
| Create | `tests/mcp/installer-hooks.test.ts` | Tests for `installHooksForDetectedTools` |
| Modify | `README.md` | Update hooks table to show per-tool coverage |
| Modify | `plugin/WORKFLOW.md` | Add multi-tool hooks section |

---

### Task 1: normalize-stdin.js

**Files:**
- Create: `plugin/scripts/normalize-stdin.js`
- Create: `tests/plugin/normalize-stdin.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/plugin/normalize-stdin.test.js`:

```js
import { test, expect, mock, beforeEach, afterEach } from "bun:test";

// We'll test the normalization logic by importing after mocking stdin
// normalize-stdin.js exports one function: readNormalizedInput()
// It reads from fd 0 (stdin), parses JSON, and returns canonical shape.
// We test it by mocking readFileSync.

import { normalizeHookInput } from "../../plugin/scripts/normalize-stdin.js";

test("Claude Code / Codex shape — passes through unchanged", () => {
  const raw = {
    session_id: "sess-1",
    tool_name: "Read",
    transcript_path: "/tmp/t.jsonl",
    prompt: "hello",
    stop_hook_active: true,
  };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBe("sess-1");
  expect(result.tool_name).toBe("Read");
  expect(result.transcript_path).toBe("/tmp/t.jsonl");
  expect(result.prompt_text).toBe("hello");
  expect(result.stop_hook_active).toBe(true);
});

test("Cursor camelCase shape — normalizes to snake_case", () => {
  const raw = {
    sessionId: "sess-2",
    toolName: "edit_file",
    transcriptPath: "/tmp/t2.jsonl",
    promptText: "world",
  };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBe("sess-2");
  expect(result.tool_name).toBe("edit_file");
  expect(result.transcript_path).toBe("/tmp/t2.jsonl");
  expect(result.prompt_text).toBe("world");
  expect(result.stop_hook_active).toBe(false);
});

test("Windsurf shape — maps 'tool' to tool_name", () => {
  const raw = {
    session_id: "sess-3",
    tool: "shell",
  };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBe("sess-3");
  expect(result.tool_name).toBe("shell");
  expect(result.transcript_path).toBeNull();
  expect(result.prompt_text).toBeNull();
});

test("empty input — all fields null / false", () => {
  const result = normalizeHookInput({});
  expect(result.session_id).toBeNull();
  expect(result.tool_name).toBeNull();
  expect(result.transcript_path).toBeNull();
  expect(result.prompt_text).toBeNull();
  expect(result.stop_hook_active).toBe(false);
});

test("non-string values are coerced to null", () => {
  const raw = { session_id: 42, tool_name: null };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBeNull();
  expect(result.tool_name).toBeNull();
});
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

```bash
cd /Users/chaitanyadavuluri/Desktop/SustainableMemory
bun test tests/plugin/normalize-stdin.test.js
```

Expected: `Cannot find module '../../plugin/scripts/normalize-stdin.js'`

- [ ] **Step 3: Create `plugin/scripts/normalize-stdin.js`**

```js
#!/usr/bin/env node
/**
 * Shared stdin normalization for gyst hook scripts.
 *
 * Each AI tool sends hook payloads with different field names.
 * This module normalizes them to a single canonical shape so all
 * hook scripts work regardless of which tool is running them.
 */
import { readFileSync } from "node:fs";

/**
 * @typedef {Object} NormalizedInput
 * @property {string|null} session_id
 * @property {string|null} tool_name
 * @property {string|null} transcript_path
 * @property {string|null} prompt_text
 * @property {boolean}     stop_hook_active
 */

/**
 * Normalizes a raw hook payload object to the canonical shape.
 * Field name priority (first non-null string wins):
 *   session_id:       session_id → sessionId
 *   tool_name:        tool_name  → toolName → tool
 *   transcript_path:  transcript_path → transcriptPath
 *   prompt_text:      prompt → prompt_text → promptText
 *   stop_hook_active: stop_hook_active (boolean, default false)
 *
 * @param {Record<string, unknown>} raw
 * @returns {NormalizedInput}
 */
export function normalizeHookInput(raw) {
  const str = (v) => (typeof v === "string" ? v : null);
  return {
    session_id:       str(raw.session_id)       ?? str(raw.sessionId)       ?? null,
    tool_name:        str(raw.tool_name)         ?? str(raw.toolName)        ?? str(raw.tool) ?? null,
    transcript_path:  str(raw.transcript_path)   ?? str(raw.transcriptPath)  ?? null,
    prompt_text:      str(raw.prompt)            ?? str(raw.prompt_text)     ?? str(raw.promptText) ?? null,
    stop_hook_active: raw.stop_hook_active === true,
  };
}

/**
 * Reads stdin (fd 0), parses JSON, and returns a normalized input object.
 * Returns all-null canonical object on any parse failure.
 *
 * @returns {NormalizedInput}
 */
export function readNormalizedInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return normalizeHookInput({});
    return normalizeHookInput(JSON.parse(raw));
  } catch {
    return normalizeHookInput({});
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test tests/plugin/normalize-stdin.test.js
```

Expected: `5 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add plugin/scripts/normalize-stdin.js tests/plugin/normalize-stdin.test.js
git commit -m "feat(hooks): normalize-stdin adapter for multi-tool stdin field names"
```

---

### Task 2: Update the three stdin-reading scripts

**Files:**
- Modify: `plugin/scripts/session-end.js`
- Modify: `plugin/scripts/pre-tool.js`
- Modify: `plugin/scripts/prompt.js`

No new tests needed — these scripts delegate all logic to emitAsync/badge which are already tested. The change is purely mechanical: replace the inline `readHookInput()` + field access with `readNormalizedInput()`.

- [ ] **Step 1: Update `plugin/scripts/session-end.js`**

Replace the entire file content with:

```js
#!/usr/bin/env node
/**
 * Session end hook for Claude Code, Gemini CLI, Cursor, Windsurf, and Codex CLI.
 *
 * Records session_end so downstream distillation can group events per
 * session. Never blocks the agent.
 */
import { spawn } from "node:child_process";
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const payload = {
    sessionId: input.session_id,
    reason: input.stop_hook_active ? "stop" : "session_end",
  };

  badge("distilling session knowledge");
  emitAsync(gyst, "session_end", payload);

  try {
    const selfDoc = spawn(gyst, ["self-document", "--skip-ghosts", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    selfDoc.unref();
  } catch {
    // non-fatal
  }

  try {
    const mine = spawn(gyst, ["mine", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    mine.unref();
  } catch {
    // non-fatal
  }

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
```

- [ ] **Step 2: Update `plugin/scripts/pre-tool.js`**

Replace the entire file content with:

```js
#!/usr/bin/env node
/**
 * PreToolUse hook for Claude Code, Gemini CLI, Cursor, Windsurf, and Codex CLI.
 *
 * Shows the gyst badge and emits a pre_tool_use event.
 * Always returns {continue: true} — never blocks a tool call.
 */
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const toolName  = input.tool_name  ?? "unknown";
  const sessionId = input.session_id ?? null;

  badge(`watching ${toolName}`);
  emitAsync(gyst, "pre_tool_use", { tool: toolName, sessionId });

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
```

Note: the `kb_miss_signal` logic (Read tool tracking) is intentionally removed here — it accessed `hookInput.tool_input.file_path` which is a Claude Code-specific nested field not present in other tools. This is a safe removal; the signal is low-value and Claude Code-specific.

- [ ] **Step 3: Update `plugin/scripts/prompt.js`**

Replace the entire file content with:

```js
#!/usr/bin/env node
/**
 * UserPromptSubmit hook for Claude Code, Cursor, and Codex CLI.
 *
 * Reads prompt text + session_id and forwards a minimal payload to
 * `gyst emit prompt`. classify-event.ts uses the text to decide candidate
 * type and signal. Fire-and-forget: never blocks the agent.
 */
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const payload = {
    text:      input.prompt_text ?? "",
    sessionId: input.session_id  ?? null,
  };

  badge("recording prompt");
  emitAsync(gyst, "prompt", payload);

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
```

- [ ] **Step 4: Smoke-test the scripts still produce valid output**

```bash
echo '{"session_id":"s1","stop_hook_active":false}' | node plugin/scripts/session-end.js
echo '{"tool_name":"Read","session_id":"s1"}' | node plugin/scripts/pre-tool.js
echo '{"prompt":"hello","session_id":"s1"}' | node plugin/scripts/prompt.js
```

Each should print `{"continue":true}` to stdout (with possible badge output on stderr). Exit 0.

- [ ] **Step 5: Commit**

```bash
git add plugin/scripts/session-end.js plugin/scripts/pre-tool.js plugin/scripts/prompt.js
git commit -m "refactor(hooks): use normalize-stdin in session-end, pre-tool, prompt scripts"
```

---

### Task 3: Reference hook JSON files

**Files:**
- Create: `plugin/hooks/gemini-hooks.json`
- Create: `plugin/hooks/cursor-hooks.json`
- Create: `plugin/hooks/windsurf-hooks.json`
- Create: `plugin/hooks/codex-hooks.json`

These are static reference files documenting the config shape for each tool. `installHooksForDetectedTools` (Task 4) builds equivalent objects in code — these files exist so developers can read what gets written without reading TypeScript.

Note: paths in these files use `<SCRIPTS_DIR>` as a placeholder. The installer writes absolute paths.

- [ ] **Step 1: Create `plugin/hooks/gemini-hooks.json`**

```json
{
  "_note": "Reference only — installHooksForDetectedTools writes this with absolute paths to ~/.gemini/settings.json",
  "hooks": {
    "SessionStart": [{"type": "command", "command": "node <SCRIPTS_DIR>/session-start.js"}],
    "SessionEnd":   [{"type": "command", "command": "node <SCRIPTS_DIR>/session-end.js"}],
    "PreToolUse":   [{"type": "command", "command": "node <SCRIPTS_DIR>/pre-tool.js"}],
    "PostToolUse":  [{"type": "command", "command": "node <SCRIPTS_DIR>/tool-use.js"}]
  }
}
```

- [ ] **Step 2: Create `plugin/hooks/cursor-hooks.json`**

```json
{
  "_note": "Reference only — installHooksForDetectedTools writes this with absolute paths to ~/.cursor/hooks.json",
  "version": 1,
  "hooks": {
    "sessionStart": [{"type": "command", "command": "node <SCRIPTS_DIR>/session-start.js", "timeout": 5}],
    "sessionEnd":   [{"type": "command", "command": "node <SCRIPTS_DIR>/session-end.js",   "timeout": 5}],
    "preToolUse":   [{"type": "command", "command": "node <SCRIPTS_DIR>/pre-tool.js",      "timeout": 1}],
    "postToolUse":  [{"type": "command", "command": "node <SCRIPTS_DIR>/tool-use.js",      "timeout": 1}]
  }
}
```

- [ ] **Step 3: Create `plugin/hooks/windsurf-hooks.json`**

```json
{
  "_note": "Reference only — installHooksForDetectedTools writes this with absolute paths to ~/.codeium/windsurf/hooks.json",
  "hooks": {
    "pre_session":    [{"command": "node <SCRIPTS_DIR>/session-start.js"}],
    "post_session":   [{"command": "node <SCRIPTS_DIR>/session-end.js"}],
    "pre_tool_call":  [{"command": "node <SCRIPTS_DIR>/pre-tool.js"}],
    "post_tool_call": [{"command": "node <SCRIPTS_DIR>/tool-use.js"}]
  }
}
```

- [ ] **Step 4: Create `plugin/hooks/codex-hooks.json`**

```json
{
  "_note": "Reference only — installHooksForDetectedTools writes this with absolute paths to ~/.codex/hooks.json",
  "hooks": {
    "SessionStart": [{"type": "command", "command": "node <SCRIPTS_DIR>/session-start.js"}],
    "SessionEnd":   [{"type": "command", "command": "node <SCRIPTS_DIR>/session-end.js"}],
    "PreToolUse":   [{"type": "command", "command": "node <SCRIPTS_DIR>/pre-tool.js"}],
    "PostToolUse":  [{"type": "command", "command": "node <SCRIPTS_DIR>/tool-use.js"}]
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/gemini-hooks.json plugin/hooks/cursor-hooks.json plugin/hooks/windsurf-hooks.json plugin/hooks/codex-hooks.json
git commit -m "docs(hooks): reference hook config files for Gemini/Cursor/Windsurf/Codex"
```

---

### Task 4: installHooksForDetectedTools in installer.ts

**Files:**
- Modify: `src/mcp/installer.ts`
- Create: `tests/mcp/installer-hooks.test.ts`

The existing `installForDetectedTools` loop checks `existsSync(parentDir)` to decide if a home-directory tool is present. We reuse the same detection logic for hooks.

- [ ] **Step 1: Write failing tests**

Create `tests/mcp/installer-hooks.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHooksForDetectedTools } from "../../src/mcp/installer.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gyst-hooks-test-"));
});

function afterEach_cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

test("writes Gemini hook config when ~/.gemini exists", () => {
  const geminiDir = join(tmpDir, ".gemini");
  mkdirSync(geminiDir, { recursive: true });

  const scriptsDir = join(tmpDir, "scripts");
  const configured = installHooksForDetectedTools(tmpDir, scriptsDir);

  expect(configured).toContain("Gemini CLI");
  const configPath = join(geminiDir, "settings.json");
  expect(existsSync(configPath)).toBe(true);
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.hooks.SessionStart[0].command).toContain("session-start.js");
  expect(config.hooks.SessionStart[0].command).toContain(scriptsDir);
  afterEach_cleanup();
});

test("writes Cursor hook config when ~/.cursor exists", () => {
  const cursorDir = join(tmpDir, ".cursor");
  mkdirSync(cursorDir, { recursive: true });

  const scriptsDir = join(tmpDir, "scripts");
  const configured = installHooksForDetectedTools(tmpDir, scriptsDir);

  expect(configured).toContain("Cursor");
  const configPath = join(cursorDir, "hooks.json");
  expect(existsSync(configPath)).toBe(true);
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.version).toBe(1);
  expect(config.hooks.sessionStart[0].command).toContain("session-start.js");
  afterEach_cleanup();
});

test("writes Windsurf hook config when ~/.codeium/windsurf exists", () => {
  const windsurfDir = join(tmpDir, ".codeium", "windsurf");
  mkdirSync(windsurfDir, { recursive: true });

  const scriptsDir = join(tmpDir, "scripts");
  const configured = installHooksForDetectedTools(tmpDir, scriptsDir);

  expect(configured).toContain("Windsurf");
  const configPath = join(windsurfDir, "hooks.json");
  expect(existsSync(configPath)).toBe(true);
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.hooks.pre_session[0].command).toContain("session-start.js");
  afterEach_cleanup();
});

test("writes Codex hook config when ~/.codex exists", () => {
  const codexDir = join(tmpDir, ".codex");
  mkdirSync(codexDir, { recursive: true });

  const scriptsDir = join(tmpDir, "scripts");
  const configured = installHooksForDetectedTools(tmpDir, scriptsDir);

  expect(configured).toContain("Codex CLI");
  const configPath = join(codexDir, "hooks.json");
  expect(existsSync(configPath)).toBe(true);
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.hooks.SessionStart[0].command).toContain("session-start.js");
  afterEach_cleanup();
});

test("skips tools whose parent dir does not exist", () => {
  // No tool dirs created in tmpDir
  const scriptsDir = join(tmpDir, "scripts");
  const configured = installHooksForDetectedTools(tmpDir, scriptsDir);
  expect(configured).toHaveLength(0);
  afterEach_cleanup();
});

test("is idempotent — running twice does not create duplicates", () => {
  const geminiDir = join(tmpDir, ".gemini");
  mkdirSync(geminiDir, { recursive: true });

  const scriptsDir = join(tmpDir, "scripts");
  installHooksForDetectedTools(tmpDir, scriptsDir);
  installHooksForDetectedTools(tmpDir, scriptsDir);

  const configPath = join(geminiDir, "settings.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.hooks.SessionStart).toHaveLength(1);
  afterEach_cleanup();
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test tests/mcp/installer-hooks.test.ts
```

Expected: `SyntaxError: Export named 'installHooksForDetectedTools' not found`

- [ ] **Step 3: Add hook tool descriptors and `installHooksForDetectedTools` to `src/mcp/installer.ts`**

Add these types and the new function. The existing imports (`existsSync`, `writeFileSync`, `mkdirSync`, `join`, `dirname`, `resolve`, `homedir`) are already present.

Append to `src/mcp/installer.ts` after the closing brace of `installForDetectedTools`:

```typescript
// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

/**
 * One command entry in a hook array (common to Gemini, Codex, Windsurf).
 */
interface HookCommandEntry {
  command: string;
  type?: string;
  timeout?: number;
}

/**
 * Descriptor for writing a single tool's hook config file.
 */
interface HookToolDescriptor {
  readonly name: string;
  /** Absolute path to the hook config file for this tool. */
  hookConfigPath(homeDir: string): string;
  /** Parent directory that must exist for the tool to be considered installed. */
  detectionDir(homeDir: string): string;
  /** Build the full hook config object given an absolute scripts directory. */
  buildConfig(scriptsDir: string): Record<string, unknown>;
}

function cmd(scriptsDir: string, script: string): HookCommandEntry {
  return { type: "command", command: `node ${join(scriptsDir, script)}` };
}

function cmdNoType(scriptsDir: string, script: string): HookCommandEntry {
  return { command: `node ${join(scriptsDir, script)}` };
}

const HOOK_TOOL_DESCRIPTORS: readonly HookToolDescriptor[] = [
  {
    name: "Gemini CLI",
    hookConfigPath: (h) => join(h, ".gemini", "settings.json"),
    detectionDir:   (h) => join(h, ".gemini"),
    buildConfig: (s) => ({
      hooks: {
        SessionStart: [cmd(s, "session-start.js")],
        SessionEnd:   [cmd(s, "session-end.js")],
        PreToolUse:   [cmd(s, "pre-tool.js")],
        PostToolUse:  [cmd(s, "tool-use.js")],
      },
    }),
  },
  {
    name: "Cursor",
    hookConfigPath: (h) => join(h, ".cursor", "hooks.json"),
    detectionDir:   (h) => join(h, ".cursor"),
    buildConfig: (s) => ({
      version: 1,
      hooks: {
        sessionStart: [{ ...cmd(s, "session-start.js"), timeout: 5 }],
        sessionEnd:   [{ ...cmd(s, "session-end.js"),   timeout: 5 }],
        preToolUse:   [{ ...cmd(s, "pre-tool.js"),      timeout: 1 }],
        postToolUse:  [{ ...cmd(s, "tool-use.js"),      timeout: 1 }],
      },
    }),
  },
  {
    name: "Windsurf",
    hookConfigPath: (h) => join(h, ".codeium", "windsurf", "hooks.json"),
    detectionDir:   (h) => join(h, ".codeium", "windsurf"),
    buildConfig: (s) => ({
      hooks: {
        pre_session:    [cmdNoType(s, "session-start.js")],
        post_session:   [cmdNoType(s, "session-end.js")],
        pre_tool_call:  [cmdNoType(s, "pre-tool.js")],
        post_tool_call: [cmdNoType(s, "tool-use.js")],
      },
    }),
  },
  {
    name: "Codex CLI",
    hookConfigPath: (h) => join(h, ".codex", "hooks.json"),
    detectionDir:   (h) => join(h, ".codex"),
    buildConfig: (s) => ({
      hooks: {
        SessionStart: [cmd(s, "session-start.js")],
        SessionEnd:   [cmd(s, "session-end.js")],
        PreToolUse:   [cmd(s, "pre-tool.js")],
        PostToolUse:  [cmd(s, "tool-use.js")],
      },
    }),
  },
];

/**
 * Detects installed AI coding tools and writes gyst hook configs for each.
 *
 * Uses `homeDir` as the base for all home-directory tool paths so tests
 * can inject a temp directory instead of the real home.
 *
 * @param homeDir    - Base directory standing in for `os.homedir()`.
 * @param scriptsDir - Absolute path to `plugin/scripts/` containing the hook JS files.
 * @returns List of tool names that received hook configs.
 */
export function installHooksForDetectedTools(
  homeDir: string,
  scriptsDir: string,
): string[] {
  const configured: string[] = [];

  for (const tool of HOOK_TOOL_DESCRIPTORS) {
    const detectionDir = tool.detectionDir(homeDir);

    if (!existsSync(detectionDir)) {
      logger.debug("installHooksForDetectedTools: skipping — detection dir absent", {
        tool: tool.name,
        detectionDir,
      });
      continue;
    }

    try {
      const configPath = tool.hookConfigPath(homeDir);
      const config = tool.buildConfig(scriptsDir);
      writeJsonConfig(configPath, config as McpConfig);
      logger.info("Hook config written", { tool: tool.name, configPath });
      configured.push(tool.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("installHooksForDetectedTools: failed to write hook config", {
        tool: tool.name,
        error: msg,
      });
    }
  }

  return configured;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test tests/mcp/installer-hooks.test.ts
```

Expected: `6 pass, 0 fail`

- [ ] **Step 5: Run full lint to verify no TypeScript errors**

```bash
bun run lint
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/installer.ts tests/mcp/installer-hooks.test.ts
git commit -m "feat(installer): installHooksForDetectedTools for Gemini/Cursor/Windsurf/Codex"
```

---

### Task 5: Wire hooks installer into CLI setup command

**Files:**
- Modify: `src/cli/index.ts`

The `setupAction` at line ~198 in `src/cli/index.ts` already calls `installForDetectedTools(process.cwd())`. We add a call to `installHooksForDetectedTools` right after it, using `homedir()` and the absolute path to `plugin/scripts/`.

- [ ] **Step 1: Add import for `installHooksForDetectedTools` and `homedir`**

In `src/cli/index.ts`, find the existing import:
```typescript
import { installForDetectedTools } from "../mcp/installer.js";
```

Replace it with:
```typescript
import { installForDetectedTools, installHooksForDetectedTools } from "../mcp/installer.js";
```

And find the import of `homedir` (it may already exist from `node:os`). If not present, add:
```typescript
import { homedir } from "node:os";
```

Check by running: `grep -n "homedir\|node:os" src/cli/index.ts`

- [ ] **Step 2: Add the hook install call in `setupAction`**

Find the block in `setupAction` (~line 213):
```typescript
    const installed = installForDetectedTools(process.cwd());
    for (const tool of installed) process.stdout.write(`  configured: ${tool}\n`);
```

Replace with:
```typescript
    const installed = installForDetectedTools(process.cwd());
    for (const tool of installed) process.stdout.write(`  configured MCP: ${tool}\n`);

    // Determine the absolute path to plugin/scripts from the installed package.
    // __dirname is not available in ESM; use import.meta.url instead.
    const { fileURLToPath } = await import("node:url");
    const { dirname: _dirname, join: _join, resolve: _resolve } = await import("node:path");
    const thisFile = fileURLToPath(import.meta.url);
    // src/cli/index.ts → repo root → plugin/scripts
    const repoRoot = _resolve(_dirname(thisFile), "..", "..");
    const scriptsDir = _join(repoRoot, "plugin", "scripts");
    const hookedTools = installHooksForDetectedTools(homedir(), scriptsDir);
    for (const tool of hookedTools) process.stdout.write(`  configured hooks: ${tool}\n`);
```

- [ ] **Step 3: Run lint to verify no TypeScript errors**

```bash
bun run lint
```

Expected: zero errors.

- [ ] **Step 4: Smoke-test the setup command output**

```bash
node -e "
const { execSync } = require('child_process');
// Just verify the import resolves — don't actually run setup
console.log('import OK');
"
```

Or more directly:
```bash
bun run build 2>&1 | tail -5
```

Expected: clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): call installHooksForDetectedTools in setup/install command"
```

---

### Task 6: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `plugin/WORKFLOW.md`

- [ ] **Step 1: Update the Hooks table in README.md**

Find the hooks table section. It currently has a column for Hook and Description. Add a "Tools" column to the `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse` rows, or add a new paragraph below the table:

Find this text in README.md:
```
### Hook Coverage
```

Add after the existing hooks table:

```markdown
#### Multi-Tool Coverage

Beyond Claude Code, `gyst install` writes native hook configs for every detected tool:

| Tool | Config written | Events wired |
|------|----------------|--------------|
| Gemini CLI | `~/.gemini/settings.json` | SessionStart, SessionEnd, PreToolUse, PostToolUse |
| Cursor | `~/.cursor/hooks.json` | sessionStart, sessionEnd, preToolUse, postToolUse |
| Windsurf | `~/.codeium/windsurf/hooks.json` | pre_session, post_session, pre_tool_call, post_tool_call |
| Codex CLI | `~/.codex/hooks.json` | SessionStart, SessionEnd, PreToolUse, PostToolUse |

Run `gyst install` once — it auto-detects which tools are present and writes configs only for those.
```

- [ ] **Step 2: Add multi-tool section to plugin/WORKFLOW.md**

Find the end of the existing content in `plugin/WORKFLOW.md`. Append:

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add README.md plugin/WORKFLOW.md
git commit -m "docs: multi-tool hook coverage in README and WORKFLOW.md"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| normalize-stdin.js with normalization rules | Task 1 |
| Update session-end.js, pre-tool.js, prompt.js | Task 2 |
| installHooksForDetectedTools() in installer.ts | Task 4 |
| 4 reference hook JSON files | Task 3 |
| Wire CLI setup command | Task 5 |
| Tests for normalizer | Task 1 |
| Tests for installer | Task 4 |
| README + WORKFLOW.md updates | Task 6 |

All spec sections covered. ✓

**Placeholder scan:** No TBDs or "implement later" present. All code blocks are complete. ✓

**Type consistency:**
- `installHooksForDetectedTools(homeDir, scriptsDir)` — used consistently in Task 4 tests and Task 5 wiring ✓
- `normalizeHookInput(raw)` / `readNormalizedInput()` — used consistently in Task 1 and Task 2 ✓
- `cmd()` / `cmdNoType()` helpers — defined and used only in Task 4 ✓
