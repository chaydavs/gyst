/**
 * Gyst install command — one-command infrastructure setup.
 *
 * Handles plumbing only — knowledge extraction is left to the agent:
 *   1. Check Bun is available and meets minimum version (>=1.1.0)
 *   2. Detect installed AI coding tools by checking user home directories
 *   3. Register Gyst MCP server config with each detected tool
 *   4. Initialize project (.gyst/, gyst-wiki/, SQLite database)
 *   5. Scan source tree for coding conventions (automated, capped at 30)
 *   6. Install git hooks inline (no external scripts)
 *   7. Register SessionStart + PreCompact hooks for Claude Code
 *   8. Print agent instructions for populating the knowledge base
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../store/database.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of the Bun version check. */
export interface BunCheck {
  readonly ok: boolean;
  readonly version: string;
}

/** Information about a single detected AI coding tool. */
export interface ToolInfo {
  readonly name: string;
  readonly detected: boolean;
  readonly configPath: string;
}

/** Shape of any tool's JSON config file. */
export interface McpConfig {
  mcpServers?: Record<string, unknown>;
  /** VS Code native MCP format uses "servers" instead of "mcpServers" */
  servers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 1;

/** The MCP entry injected into every detected tool's config. */
const GYST_MCP_ENTRY = {
  command: "bunx",
  args: ["gyst-mcp", "serve"],
} as const;

// ---------------------------------------------------------------------------
// Step 1 — Dependency check
// ---------------------------------------------------------------------------

/**
 * Checks if Bun is present and meets the minimum required version (>=1.1.0).
 *
 * @returns `{ ok, version }` — ok is false when Bun is missing or too old.
 */
export function checkBunVersion(): BunCheck {
  const version = (process.versions as Record<string, string>)["bun"] ?? "";
  if (!version) {
    return { ok: false, version: "" };
  }
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok =
    major > MIN_BUN_MAJOR ||
    (major === MIN_BUN_MAJOR && minor >= MIN_BUN_MINOR);
  return { ok, version };
}

// ---------------------------------------------------------------------------
// Step 2 — Tool detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the given CLI command is on PATH.
 * Uses spawnSync (no shell) to avoid injection risk.
 */
function hasCli(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Detects which AI coding tools are installed by checking user home directories
 * and, for CLI tools, probing PATH with `which`.
 *
 * @returns Array of tool info objects, one per supported tool.
 */
export function detectTools(): ToolInfo[] {
  const home = homedir();
  const cwd = process.cwd();

  const openCodeInProject = join(cwd, "opencode.json");
  const openCodePath = existsSync(openCodeInProject)
    ? openCodeInProject
    : join(home, ".config", "opencode", "config.json");
  const openCodeDetected =
    existsSync(openCodeInProject) ||
    existsSync(join(home, ".config", "opencode"));

  return [
    {
      name: "Claude Code",
      detected: existsSync(join(home, ".claude")),
      // Claude Code reads user-level MCPs from ~/.claude.json (shown in /mcp dialog).
      // Hooks live in ~/.claude/settings.json — registerHooks() handles that separately.
      configPath: join(home, ".claude.json"),
    },
    {
      name: "Cursor",
      detected: existsSync(join(home, ".cursor")),
      configPath: join(home, ".cursor", "mcp.json"),
    },
    {
      name: "Windsurf",
      detected: existsSync(join(home, ".codeium", "windsurf")),
      configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
    {
      name: "Gemini CLI",
      detected: existsSync(join(home, ".gemini")),
      configPath: join(home, ".gemini", "settings.json"),
    },
    {
      name: "Codex CLI",
      detected: existsSync(join(home, ".codex")) || hasCli("codex"),
      // Codex v0.121+ uses config.toml; we register via `codex mcp add` CLI
      // rather than writing JSON. configPath is kept as a sentinel for detection.
      configPath: join(home, ".codex", "config.toml"),
    },
    {
      name: "OpenCode",
      detected: openCodeDetected,
      configPath: openCodePath,
    },
    {
      name: "Continue",
      detected: existsSync(join(home, ".continue")),
      configPath: join(home, ".continue", "config.json"),
    },
    {
      // VS Code native MCP support (v1.99+). Uses "servers" key, not "mcpServers".
      // macOS stores config in ~/Library/Application Support/Code/User/
      // Linux stores config in ~/.config/Code/User/
      name: "VS Code",
      detected:
        existsSync(join(home, "Library", "Application Support", "Code", "User")) ||
        existsSync(join(home, ".config", "Code", "User")),
      configPath: existsSync(join(home, "Library", "Application Support", "Code", "User"))
        ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
        : join(home, ".config", "Code", "User", "mcp.json"),
    },
    {
      // GitHub Copilot standalone MCP config (used by github.com/copilot-extensions)
      name: "GitHub Copilot",
      detected: existsSync(join(home, ".github", "copilot")),
      configPath: join(home, ".github", "copilot", "mcp.json"),
    },
    {
      // LM Studio desktop app (https://lmstudio.ai)
      name: "LM Studio",
      detected: existsSync(join(home, ".lmstudio")),
      configPath: join(home, ".lmstudio", "mcp.json"),
    },
    {
      // Kiro (AWS AI IDE, https://kiro.dev)
      name: "Kiro",
      detected: existsSync(join(home, ".kiro")),
      configPath: join(home, ".kiro", "settings", "mcp.json"),
    },
  ];
}

// ---------------------------------------------------------------------------
// Step 3 — MCP config helpers (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON config file.
 * Returns an empty object if the file does not exist or cannot be parsed.
 */
function readJsonConfig(filePath: string): McpConfig {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as McpConfig;
  } catch {
    logger.warn("install: could not parse config file", { filePath });
    return {};
  }
}

/**
 * Writes a config object to disk as formatted JSON.
 * Creates parent directories if they do not exist.
 */
function writeJsonConfig(filePath: string, config: McpConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Writes a hooks.json file with absolute script paths to `targetDir`.
 * Creates the directory if it does not exist.
 *
 * Claude Code and Codex share the same hooks.json schema; the only
 * difference is the destination directory.
 */
export function writeHooksPlugin(targetDir: string): void {
  const here = import.meta.dir;
  const candidates = [
    join(here, "..", "..", "plugin", "scripts"),
    join(here, "..", "plugin", "scripts"),
    join(here, "plugin", "scripts"),
  ];
  const scriptsDir = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  const hooksConfig = {
    hooks: [
      { event: "SessionStart", script: join(scriptsDir, "session-start.js"), timeout: 5000 },
      { event: "UserPromptSubmit", script: join(scriptsDir, "prompt.js"), timeout: 2000 },
      { event: "PostToolUse", matcher: "", script: join(scriptsDir, "tool-use.js"), timeout: 2000 },
      { event: "Stop", script: join(scriptsDir, "session-end.js"), timeout: 5000 },
    ],
  };
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "hooks.json"), JSON.stringify(hooksConfig, null, 2) + "\n", "utf-8");
}

/**
 * Returns a new config with the Gyst MCP entry merged into `mcpServers`.
 * Does not mutate the original.
 *
 * @param config - Existing tool config.
 * @returns New config object with `mcpServers.gyst` set.
 */
export function mergeGystMcpEntry(config: McpConfig): McpConfig {
  const existing =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? config.mcpServers
      : {};
  return {
    ...config,
    mcpServers: { ...existing, gyst: GYST_MCP_ENTRY },
  };
}

/**
 * Returns a new config with the Gyst HTTP MCP entry merged into `mcpServers`.
 *
 * Used when a developer joins a team that hosts a shared gyst HTTP server.
 * The HTTP entry replaces the stdio entry so the agent talks to the shared
 * server instead of starting a local process.
 *
 * @param config     - Existing tool config.
 * @param serverUrl  - Base URL of the shared gyst server (e.g. http://host:3456).
 * @param memberKey  - The developer's Bearer token.
 * @returns New config object with `mcpServers.gyst` pointing at the HTTP server.
 */
export function mergeGystHttpEntry(
  config: McpConfig,
  serverUrl: string,
  memberKey: string,
): McpConfig {
  const existing =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? config.mcpServers
      : {};
  const base = serverUrl.replace(/\/$/, "");
  return {
    ...config,
    mcpServers: {
      ...existing,
      gyst: {
        type: "streamable-http",
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${memberKey}` },
      },
    },
  };
}

/**
 * Writes the Gyst HTTP MCP entry to every detected tool's config file.
 *
 * Called after a successful remote `gyst join --server` so the developer's
 * agents automatically point at the shared server without manual config editing.
 *
 * @param serverUrl - Base URL of the shared gyst HTTP server.
 * @param memberKey - The developer's Bearer token returned by join.
 * @returns List of tool names that were successfully configured.
 */
export function writeHttpMcpConfig(serverUrl: string, memberKey: string): string[] {
  const tools = detectTools();
  const configured: string[] = [];

  for (const tool of tools.filter((t) => t.detected)) {
    try {
      const existing = readJsonConfig(tool.configPath);
      // VS Code uses the "servers" key — use mergeGystVSCodeEntry first, then
      // patch the gyst entry to be HTTP instead of stdio.
      const updated = tool.name === "VS Code"
        ? {
            ...existing,
            servers: {
              ...(typeof existing.servers === "object" && existing.servers !== null
                ? (existing.servers as Record<string, unknown>)
                : {}),
              gyst: {
                type: "streamable-http",
                url: `${serverUrl.replace(/\/$/, "")}/mcp`,
                headers: { Authorization: `Bearer ${memberKey}` },
              },
            },
          }
        : mergeGystHttpEntry(existing, serverUrl, memberKey);
      writeJsonConfig(tool.configPath, updated);
      configured.push(tool.name);
    } catch {
      // Non-fatal — tool config may be read-only or in an unexpected format.
    }
  }

  return configured;
}

/**
 * Returns a new VS Code mcp.json config with the Gyst server merged.
 * VS Code uses `"servers"` (not `"mcpServers"`) and a `"type": "stdio"` field.
 *
 * @param config - Existing VS Code mcp.json content.
 * @returns New config object with `servers.gyst` set.
 */
export function mergeGystVSCodeEntry(config: McpConfig): McpConfig {
  const existing =
    typeof config.servers === "object" && config.servers !== null
      ? (config.servers as Record<string, unknown>)
      : {};
  return {
    ...config,
    servers: {
      ...existing,
      gyst: { ...GYST_MCP_ENTRY, type: "stdio" },
    },
  };
}

/**
 * Returns a new config with Gyst's lifecycle hooks merged
 * into the Claude Code `hooks` block. Existing Gyst hooks are replaced to
 * prevent duplicates; non-Gyst hooks are preserved. Does not mutate the original.
 *
 * @param config - Existing Claude Code settings.json content.
 * @returns New config object with Gyst hooks injected.
 */
export function mergeClaudeHooks(config: McpConfig): McpConfig {
  type HookEntry = { matcher: string; hooks: { type: string; command: string }[] };

  const isGystHook = (h: HookEntry): boolean =>
    h.hooks.some((cmd) => cmd.command.startsWith("gyst "));

  const gystSessionStart: HookEntry = {
    matcher: "auto",
    hooks: [
      {
        type: "command",
        command: "gyst emit session_start 2>/dev/null || true"
      },
      { 
        type: "command", 
        command: "gyst inject-context --always-on --graph-traverse" 
      }
    ],
  };
  const gystPreCompact: HookEntry = {
    matcher: "auto",
    hooks: [{ type: "command", command: "gyst emit pre_compact 2>/dev/null || true" }],
  };
  const gystPrompt: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "gyst emit prompt 2>/dev/null || true" }],
  };
  const gystToolUse: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "gyst emit tool_use 2>/dev/null || true" }],
  };
  const gystStop: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "gyst emit session_end 2>/dev/null || true" }],
  };

  const existingHooks =
    typeof config.hooks === "object" && config.hooks !== null
      ? (config.hooks as Record<string, HookEntry[]>)
      : {};

  const merge = (existing: HookEntry[] | undefined, toAdd: HookEntry): HookEntry[] => [
    ...(existing ?? []).filter((h) => !isGystHook(h)),
    toAdd,
  ];

  return {
    ...config,
    hooks: {
      ...existingHooks,
      SessionStart: merge(existingHooks["SessionStart"], gystSessionStart),
      PreCompact: merge(existingHooks["PreCompact"], gystPreCompact),
      UserPromptSubmit: merge(existingHooks["UserPromptSubmit"], gystPrompt),
      PostToolUse: merge(existingHooks["PostToolUse"], gystToolUse),
      Stop: merge(existingHooks["Stop"], gystStop),
    },
  };
}

/**
 * Returns a new config with Gyst's Gemini CLI hooks merged into settings.json.
 *
 * Gemini CLI's schema is identical to Claude Code's: each event maps to an
 * ARRAY of `{matcher, hooks: [{name, type, command, timeout}]}` entries.
 * Valid Gemini events: SessionStart, SessionEnd, BeforeAgent, AfterAgent,
 * BeforeTool, AfterTool. Writing strings (as an older revision of this
 * function did) crashes Gemini with "Expected array, received string".
 *
 * Existing Gyst-owned entries are filtered out before merging to keep the
 * merge idempotent. Other plugins' entries (claude-mem, user-authored) are
 * preserved.
 *
 * @param config - Existing Gemini CLI settings.json content.
 * @returns New config object with Gyst hooks injected.
 */
export function mergeGeminiHooks(config: McpConfig): McpConfig {
  type GeminiHookEntry = {
    matcher: string;
    hooks: { name?: string; type: string; command: string; timeout?: number }[];
  };

  const VALID_GEMINI_EVENTS = new Set([
    "SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent",
    "BeforeTool", "AfterTool",
  ]);

  const entry = (cmd: string): GeminiHookEntry => ({
    matcher: "*",
    hooks: [
      { name: "gyst", type: "command", command: cmd, timeout: 2000 },
    ],
  });

  const gystEntries: Record<string, GeminiHookEntry> = {
    SessionStart: entry("gyst emit session_start 2>/dev/null || true"),
    SessionEnd:   entry("gyst emit session_end 2>/dev/null || true"),
    AfterTool:    entry("gyst emit tool_use 2>/dev/null || true"),
  };

  const raw = (config.hooks as Record<string, unknown>) || {};
  const out: Record<string, GeminiHookEntry[]> = {};

  // Copy through any existing arrays, dropping prior Gyst-owned entries and
  // any invalid event names the older merge may have written (Prompt,
  // ToolUse, Error, PostCommit, PostMerge).
  for (const [event, value] of Object.entries(raw)) {
    if (!VALID_GEMINI_EVENTS.has(event)) continue;
    if (!Array.isArray(value)) continue;
    const kept = (value as GeminiHookEntry[]).filter(
      (h) => !h.hooks?.some((cmd) =>
        cmd?.name === "gyst" || cmd?.command?.startsWith("gyst "),
      ),
    );
    if (kept.length > 0) out[event] = kept;
  }

  // Merge Gyst entries on top.
  for (const [event, gyst] of Object.entries(gystEntries)) {
    out[event] = [...(out[event] ?? []), gyst];
  }

  return { ...config, hooks: out };
}

// ---------------------------------------------------------------------------
// Step 4 — Project initialisation
// ---------------------------------------------------------------------------

/**
 * Creates `.gyst/` and `gyst-wiki/` directories and initialises the SQLite
 * database at `.gyst/wiki.db`.
 *
 * @param dir - Project root directory. Defaults to `process.cwd()`.
 */
export function initProject(dir: string = process.cwd()): void {
  mkdirSync(join(dir, ".gyst"), { recursive: true });
  mkdirSync(join(dir, "gyst-wiki"), { recursive: true });
  // Database is created by the caller via initDatabase(loadConfig(dir).dbPath)
  // at .gyst/wiki.db — NOT here — to keep one canonical DB location.
}

// ---------------------------------------------------------------------------
// Stdin helpers (interactive I/O)
// ---------------------------------------------------------------------------

/**
 * Prints an inline y/n prompt and returns true for y/yes.
 *
 * The reader must be acquired ONCE by the top-level flow and passed in.
 * Re-acquiring `Bun.stdin.stream().getReader()` per call drops buffered
 * bytes in Bun (seen in the wild with multi-prompt install flows).
 */
async function askYesNo(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  question: string,
): Promise<boolean> {
  process.stdout.write(`\n  ? ${question} (y/n) `);
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("\n")) break;
  }
  const answer = buffer.split("\n")[0]!.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Reads a single line of free-form input from stdin.
 *
 * Same reader-reuse rules as `askYesNo` — the caller must pass the single
 * reader acquired at the top of the flow, not re-acquire one per prompt.
 */
async function askLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  question: string,
): Promise<string> {
  process.stdout.write(`\n  ? ${question} `);
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("\n")) break;
  }
  return buffer.split("\n")[0]!.trim();
}

/**
 * Prompts the user to pick a number in [1, max] and re-prompts on bad input.
 */
async function askChoice(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  question: string,
  max: number,
): Promise<number> {
  while (true) {
    const raw = await askLine(reader, question);
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= max) return n;
    process.stdout.write(`    Please enter a number between 1 and ${max}.\n`);
  }
}

// ---------------------------------------------------------------------------
// Privacy mode helpers — .gitignore and .gyst-wiki.json writers
// ---------------------------------------------------------------------------

/** Idempotently append a pattern to `.gitignore`. Creates the file if missing. */
function appendGitignoreLine(projectDir: string, pattern: string): boolean {
  const path = join(projectDir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern)) return false;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}${pattern}\n`, "utf-8");
  return true;
}

/**
 * Ensures the project's `.gitignore` hides Gyst's local state so agent-authored
 * knowledge does not leak into the client repo.
 *
 * @returns The patterns that were newly added (empty array = already present).
 */
export function ensureGitignore(projectDir: string = process.cwd()): string[] {
  const patterns = ["gyst-wiki/", ".gyst/"] as const;
  const added: string[] = [];
  for (const p of patterns) {
    if (appendGitignoreLine(projectDir, p)) added.push(p);
  }
  return added;
}

/** Merges the given partial config into `.gyst-wiki.json`. Creates the file if missing. */
export function writeProjectConfig(
  projectDir: string,
  updates: Record<string, unknown>,
): void {
  const path = join(projectDir, ".gyst-wiki.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      logger.warn("install: could not parse .gyst-wiki.json, overwriting", { path });
    }
  }
  const merged = { ...existing, ...updates };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Step 3 (interactive) — Register MCP configs
// ---------------------------------------------------------------------------

async function registerMcpForTools(
  tools: ToolInfo[],
  stdinReader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string[]> {
  const configured: string[] = [];

  for (const tool of tools.filter((t) => t.detected)) {
    // Codex CLI v0.121+ uses config.toml and a native `codex mcp add` command
    if (tool.name === "Codex CLI") {
      try {
        // Check if already registered
        const checkResult = spawnSync("codex", ["mcp", "list"], { encoding: "utf-8" });
        const alreadyRegistered = checkResult.stdout?.includes("gyst");
        if (alreadyRegistered) {
          process.stdout.write(`    ${tool.name}: already configured\n`);
        } else {
          const addResult = spawnSync("codex", ["mcp", "add", "gyst", "--", "bunx", "gyst-mcp", "serve"], { encoding: "utf-8" });
          if (addResult.status === 0) {
            process.stdout.write(`    ${tool.name}: registered via codex mcp add ✓\n`);
          } else {
            process.stdout.write(`    ${tool.name}: codex mcp add failed — ${addResult.stderr ?? ""}\n`);
          }
        }
        configured.push(tool.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`    ${tool.name}: failed (${msg})\n`);
      }
      continue;
    }

    const existing = readJsonConfig(tool.configPath);

    // VS Code uses "servers" key; all other tools use "mcpServers"
    const isVSCode = tool.name === "VS Code";
    const serverMap = isVSCode ? existing.servers : existing.mcpServers;
    const alreadyConfigured =
      typeof serverMap === "object" && serverMap !== null && "gyst" in serverMap;

    if (alreadyConfigured) {
      const overwrite = await askYesNo(
        stdinReader,
        `Gyst is already configured for ${tool.name}. Overwrite?`,
      );
      if (!overwrite) {
        process.stdout.write(`    ${tool.name}: skipped (already configured)\n`);
        configured.push(tool.name);
        continue;
      }
    }

    try {
      const merged = isVSCode ? mergeGystVSCodeEntry(existing) : mergeGystMcpEntry(existing);
      writeJsonConfig(tool.configPath, merged);
      process.stdout.write(`    ${tool.name}: wrote to ${tool.configPath}\n`);
      configured.push(tool.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`    ${tool.name}: failed (${msg})\n`);
      logger.warn("install: failed to write MCP config", { tool: tool.name, error: msg });
    }
  }

  return configured;
}

// ---------------------------------------------------------------------------
// Step 5 (interactive) — Convention scanning
// ---------------------------------------------------------------------------

async function scanAndSaveConventions(db: Database, projectDir: string): Promise<number> {
  process.stdout.write("\n  ✓ Scanning conventions...\n");

  const { detectConventions } = await import("../compiler/detect-conventions.js");
  const { storeDetectedConventions } = await import("../compiler/store-conventions.js");

  const conventions = await detectConventions(projectDir);

  if (conventions.length === 0) {
    process.stdout.write("    No conventions detected.\n");
    return 0;
  }

  // Show a preview of up to 8 conventions.
  for (const c of conventions.slice(0, 8)) {
    const pct = `${(c.confidence * 100).toFixed(0)}%`;
    process.stdout.write(
      `    ${c.directory.padEnd(24)} ${c.pattern.padEnd(32)} (${pct})\n`,
    );
  }
  if (conventions.length > 8) {
    process.stdout.write(`    … and ${conventions.length - 8} more\n`);
  }

  const stored = await storeDetectedConventions(db, conventions);
  process.stdout.write(`    → Saved ${stored} conventions\n`);
  return stored;
}

// ---------------------------------------------------------------------------
// Step 6 — Git hooks (inline, no external scripts)
// ---------------------------------------------------------------------------

/** Lines we inject into git hooks. Idempotent — safe to call repeatedly. */
const GIT_HOOKS: ReadonlyArray<{ file: string; line: string }> = [
  { file: "post-commit", line: "gyst emit commit 2>/dev/null || true" },
  { file: "post-merge", line: "gyst emit pull 2>/dev/null || true" },
];

/**
 * Installs git hooks inline without external scripts.
 *
 * For each hook: if the file exists, appends the gyst line only when not
 * already present (preserves Husky/Lefthook hooks). If absent, creates a
 * minimal hook file with the correct shebang and marks it executable.
 *
 * Silently skips when `.git/` is not found (e.g. monorepo sub-package).
 *
 * @param projectDir - Root directory of the project (default: cwd).
 */
export function installGitHooks(projectDir: string = process.cwd()): {
  installed: string[];
  skipped: string[];
  noGit: boolean;
} {
  const gitDir = join(projectDir, ".git");
  if (!existsSync(gitDir)) {
    return { installed: [], skipped: [], noGit: true };
  }

  const hooksDir = join(gitDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const { file, line } of GIT_HOOKS) {
    const hookPath = join(hooksDir, file);

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes("gyst")) {
        skipped.push(file);
        continue;
      }
      // Append without overwriting existing hooks (Husky, Lefthook, etc.)
      writeFileSync(hookPath, `${existing.trimEnd()}\n${line}\n`);
    } else {
      writeFileSync(hookPath, `#!/bin/sh\n${line}\n`);
      chmodSync(hookPath, 0o755);
    }
    installed.push(file);
  }

  return { installed, skipped, noGit: false };
}

// ---------------------------------------------------------------------------
// Step 7 (interactive) — Hook registration
// ---------------------------------------------------------------------------

async function registerHooks(tools: ToolInfo[]): Promise<void> {
  let totalRegistered = 0;

  // Claude Code — two registration paths:
  //   (a) plugin hooks.json (for future marketplace-installed plugin use)
  //   (b) settings.json merge (actually fires today for npm-installed users)
  const claude = tools.find((t) => t.name === "Claude Code");
  if (claude?.detected) {
    try {
      writeHooksPlugin(join(homedir(), ".claude", "plugins", "gyst"));
      process.stdout.write("    Claude Code plugin hooks.json    ✓ (SessionStart, UserPromptSubmit, PostToolUse, Stop)\n");
      totalRegistered += 4;
    } catch (err) {
      logger.warn("install: failed to write Claude Code plugin hooks", { error: err });
      process.stdout.write("    Claude Code plugin hooks.json    ✗ (see logs)\n");
    }

    try {
      // Hooks always go to ~/.claude/settings.json (not ~/.claude.json which is for MCPs)
      const settingsPath = join(homedir(), ".claude", "settings.json");
      const existing = readJsonConfig(settingsPath);
      writeJsonConfig(settingsPath, mergeClaudeHooks(existing));
      process.stdout.write("    Claude Code settings.json hooks  ✓ (SessionStart, PreCompact)\n");
      totalRegistered += 2;
    } catch (err) {
      logger.warn("install: failed to merge Claude Code settings.json hooks", { error: err });
      process.stdout.write("    Claude Code settings.json hooks  ✗ (see logs)\n");
    }
  }

  // Codex CLI — same hooks.json format; write to ~/.codex/
  const codex = tools.find((t) => t.name === "Codex CLI");
  if (codex?.detected) {
    try {
      writeHooksPlugin(join(homedir(), ".codex"));
      process.stdout.write("    Codex plugin hooks.json          ✓ (4 lifecycle hooks)\n");
      totalRegistered += 4;
    } catch (err) {
      logger.warn("install: failed to write Codex hooks", { error: err });
    }
  }

  // Gemini CLI — different hook format; merge into ~/.gemini/settings.json
  const gemini = tools.find((t) => t.name === "Gemini CLI");
  if (gemini?.detected) {
    try {
      const existing = readJsonConfig(gemini.configPath);
      writeJsonConfig(gemini.configPath, mergeGeminiHooks(existing));
      process.stdout.write("    Gemini CLI settings.json hooks   ✓ (7 lifecycle hooks)\n");
      totalRegistered += 7;
    } catch (err) {
      logger.warn("install: failed to write Gemini CLI hooks", { error: err });
    }
  }

  // MCP-only tools (no hook system available)
  const mcpOnlyTools = ["Cursor", "Windsurf", "Continue", "OpenCode"];
  for (const toolName of mcpOnlyTools) {
    const tool = tools.find((t) => t.name === toolName);
    if (tool?.detected) {
      process.stdout.write(`    ${toolName.padEnd(32)} ✓ (MCP only — no lifecycle hooks)\n`);
    }
  }

  process.stdout.write(`\n    → Registered ${totalRegistered} session hooks\n`);
}

// ---------------------------------------------------------------------------
// Agent rule file injection
// ---------------------------------------------------------------------------

/**
 * Gyst usage block appended to agent rule files.
 * Plain Markdown so it renders in every host that reads these files.
 */
const GYST_AGENT_BLOCK = `
## Gyst — Team Knowledge Layer

Gyst gives you access to your team's accumulated knowledge: conventions,
decisions, known error patterns, and learnings from past sessions.

**Always use Gyst when:**
- Starting a new task → call \`read({ action: "recall", query: "<task description>" })\` to surface relevant context
- Discovering something important → call \`learn\` to record it for the team
- Validating a file → call \`check({ file_path })\` to catch convention violations

**Core tools:**
- \`read\` — read team knowledge. \`action\`: \`recall\` (default, ranked full-content) · \`search\` (compact index) · \`get_entry\` (by id)
- \`learn\` — record conventions, decisions, and learnings
- \`check\` — check code/errors. \`action\`: \`violations\` (default, validate a file) · \`conventions\` (rules for a path) · \`failures\` (known-error lookup)
- \`admin\` — team observability. \`action\`: \`activity\` (default) · \`status\`
- \`conventions\` — list coding standards for a directory

Legacy names \`recall\`, \`search\`, \`get_entry\`, \`check_conventions\`, \`failures\`, \`activity\`, \`status\` still work with a deprecation notice — prefer the unified tools.

Run \`gyst status\` to confirm the MCP server is active.
`;

/**
 * Describes a candidate rule file and whether to create it if absent.
 */
interface RuleFileSpec {
  /** Path relative to the project root. */
  readonly relPath: string;
  /**
   * When true, create the file even if it doesn't exist (parent dir must exist).
   * When false, only append if the file already exists.
   */
  readonly createIfAbsent: boolean;
}

const RULE_FILE_SPECS: readonly RuleFileSpec[] = [
  // Root-level rule files: create them in any project directory.
  { relPath: "CLAUDE.md", createIfAbsent: true },
  { relPath: "AGENTS.md", createIfAbsent: true },
  { relPath: "GEMINI.md", createIfAbsent: true },
  // Tool-specific files: createIfAbsent=true so we create when parent dir
  // exists (parent existence = tool is installed). Guards are in writeAgentRules.
  { relPath: join(".cursor", "rules", "gyst.mdc"), createIfAbsent: true },
  { relPath: join(".github", "copilot-instructions.md"), createIfAbsent: true },
  { relPath: join(".kiro", "steering", "gyst.md"), createIfAbsent: true },
];

/** Sentinel that marks an already-injected block — prevents duplicates. */
const GYST_BLOCK_SENTINEL = "## Gyst — Team Knowledge Layer";

/**
 * Appends the Gyst usage block to agent rule files in the project root.
 *
 * Idempotent: re-running will not duplicate the block.
 * For files that don't exist, we create them when `createIfAbsent` is true
 * and the parent directory exists.
 *
 * Returns the list of file paths that were written.
 */
export function writeAgentRules(projectDir: string): string[] {
  const written: string[] = [];

  for (const spec of RULE_FILE_SPECS) {
    const fullPath = join(projectDir, spec.relPath);
    const parentDir = dirname(fullPath);

    const fileExists = existsSync(fullPath);
    const parentExists = existsSync(parentDir);

    if (!fileExists && (!spec.createIfAbsent || !parentExists)) {
      // Skip: file absent and we either shouldn't create it or the parent dir
      // doesn't exist (tool not installed).
      continue;
    }

    const existing = fileExists ? readFileSync(fullPath, "utf8") : "";

    if (existing.includes(GYST_BLOCK_SENTINEL)) {
      // Already injected — nothing to do.
      continue;
    }

    const updated = existing.trimEnd() + "\n" + GYST_AGENT_BLOCK;

    if (!parentExists) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(fullPath, updated, "utf8");
    written.push(spec.relPath);
  }

  return written;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Runs the Gyst infrastructure setup flow.
 *
 * Sets up the plumbing (MCP config, database, git hooks, conventions).
 * Knowledge extraction is left to the agent — it reads code better than
 * any script can.
 */
export async function runInstall(): Promise<void> {
  process.stdout.write("\n");

  // Acquire stdin reader ONCE — re-acquiring it per prompt drops buffered
  // bytes in Bun and causes prompts after the first to hang or abort.
  const stdinReader = Bun.stdin.stream().getReader();

  // Step 1: Bun version check
  process.stdout.write("  ✓ Checking dependencies...\n");
  const bunCheck = checkBunVersion();
  if (!bunCheck.ok) {
    process.stdout.write(
      "    Gyst requires Bun >=1.1.0.\n" +
        "    Install: curl -fsSL https://bun.sh/install | bash\n",
    );
    process.exit(1);
  }
  process.stdout.write(`    Bun ${bunCheck.version} ✓\n`);

  // Step 2: Tool detection
  process.stdout.write("\n  ✓ Detecting AI coding tools...\n");
  const tools = detectTools();
  for (const tool of tools) {
    process.stdout.write(`    ${tool.name} ${tool.detected ? "✓" : "✗"}\n`);
  }

  // Scope-selection prompt — see ARCHITECTURE.md §3 "Install-Time Privacy Prompt".
  // Determines where the knowledge base lives: local dir, sibling private repo,
  // or a shared HTTP server. Written to .gyst-wiki.json so `gyst privacy` can
  // switch modes later without reinstalling.
  process.stdout.write(`
  Where should this knowledge base live?
    1. Just me (solo)                        → local only
    2. My team, internal/OSS code            → local only
    3. My team, some client work             → private wiki repo
    4. My team, strict privacy required      → HTTP server
`);
  const scopeChoice = await askChoice(stdinReader, "Choose [1-4]:", 4);
  type PrivacyMode = "local" | "private-repo" | "http-server";
  const privacyMode: PrivacyMode =
    scopeChoice === 3 ? "private-repo" : scopeChoice === 4 ? "http-server" : "local";

  // Path 2 — ask where the sibling wiki repo lives.
  let privateWikiDir: string | null = null;
  if (privacyMode === "private-repo") {
    const parentDefault = join(process.cwd(), "..", "gyst-wiki-private");
    const raw = await askLine(
      stdinReader,
      `Path to your private wiki repo (default: ${parentDefault}):`,
    );
    const resolved = raw.length > 0 ? raw : parentDefault;
    privateWikiDir = resolved.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resolved)
      ? resolved
      : join(process.cwd(), resolved);
  }

  // Path 3 — ask for server URL + invite key, then remote-join to get a member key.
  let httpServerUrl: string | null = null;
  let httpMemberKey: string | null = null;
  if (privacyMode === "http-server") {
    httpServerUrl = await askLine(
      stdinReader,
      "Gyst HTTP server URL (e.g. http://team.example.com:3456):",
    );
    if (!httpServerUrl) {
      process.stdout.write("    Server URL is required for this path. Aborting.\n");
      process.exit(1);
    }
    const inviteKey = await askLine(stdinReader, "Invite key from `gyst team invite`:");
    if (!inviteKey) {
      process.stdout.write("    Invite key is required for this path. Aborting.\n");
      process.exit(1);
    }
    const displayName =
      (await askLine(stdinReader, "Your display name:")) || process.env["USER"] || "Developer";

    try {
      const joinUrl = httpServerUrl.replace(/\/$/, "") + "/team/join";
      const res = await fetch(joinUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${inviteKey}`,
        },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) {
        const body = await res.text();
        process.stdout.write(`    Remote join failed: ${res.status} ${body}\n`);
        process.exit(1);
      }
      const data = (await res.json()) as { memberKey?: string };
      if (!data.memberKey) {
        process.stdout.write("    Server did not return a member key. Aborting.\n");
        process.exit(1);
      }
      httpMemberKey = data.memberKey;
      process.stdout.write(`    ✓ Joined. Member key: ${httpMemberKey}\n`);
      process.stdout.write(`    Add to your shell: export GYST_API_KEY="${httpMemberKey}"\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`    Could not reach server: ${msg}\n`);
      process.exit(1);
    }
  }

  // Step 3: MCP registration — HTTP mode writes Bearer-token configs instead of stdio.
  const detectedTools = tools.filter((t) => t.detected);
  if (detectedTools.length > 0) {
    process.stdout.write("\n  ✓ Registering Gyst MCP server...\n");
    if (privacyMode === "http-server" && httpServerUrl && httpMemberKey) {
      const configured = writeHttpMcpConfig(httpServerUrl, httpMemberKey);
      for (const name of configured) {
        process.stdout.write(`    ${name}: wrote Bearer-token HTTP config ✓\n`);
      }
    } else {
      await registerMcpForTools(tools, stdinReader);
    }
  }

  // Step 4: Project init
  process.stdout.write("\n  ✓ Initializing project...\n");
  const cwd = process.cwd();
  const alreadyInit = existsSync(join(cwd, ".gyst"));
  if (alreadyInit) {
    const reinit = await askYesNo(stdinReader, "Gyst already initialized. Reinitialize?");
    if (reinit) {
      initProject();
      process.stdout.write("    Reinitialized .gyst/ and gyst-wiki/\n");
    } else {
      process.stdout.write("    Skipping project initialization.\n");
    }
  } else {
    // Warn if an ancestor directory already has a Gyst project — running
    // install here would create a second, nested knowledge base and the
    // user would lose track of which is which.
    const { findProjectRoot } = await import("../utils/config.js");
    const ancestorRoot = findProjectRoot(cwd);
    if (ancestorRoot && ancestorRoot !== cwd) {
      process.stdout.write(
        `    ⚠  A Gyst project already exists at: ${ancestorRoot}\n` +
          `       Running install here would create a second, nested project.\n`,
      );
      const forced = process.env["GYST_FORCE_NESTED"] === "1";
      const proceed = forced
        ? true
        : await askYesNo(
            stdinReader,
            "Create a nested project anyway? (say no to use the existing one)",
          );
      if (!proceed) {
        process.stdout.write(
          `    Using existing project at ${ancestorRoot}. You can run 'gyst' commands from any subfolder.\n`,
        );
        return;
      }
      if (forced) {
        process.stdout.write("    GYST_FORCE_NESTED=1 — creating nested project.\n");
      }
    }
    // Paths 2 & 3 skip in-project gyst-wiki/ creation — Path 2's wiki lives at a
    // sibling repo path (created later from privateWikiDir), Path 3's wiki lives
    // on the HTTP server. Keeping gyst-wiki/ out of the client repo is the whole
    // point of those modes.
    if (privacyMode === "local") {
      initProject();
      process.stdout.write("    Created .gyst/\n");
      process.stdout.write("    Created gyst-wiki/\n");
    } else {
      mkdirSync(join(cwd, ".gyst"), { recursive: true });
      process.stdout.write("    Created .gyst/\n");
      const reason = privacyMode === "http-server" ? "HTTP server mode" : "private repo mode";
      process.stdout.write(`    Skipped gyst-wiki/ (${reason})\n`);
    }
  }

  // Persist scope selection so `gyst privacy` can read the current mode later.
  const configUpdates: Record<string, unknown> = { privacyMode };
  if (privacyMode === "private-repo" && privateWikiDir) {
    configUpdates["wikiDir"] = privateWikiDir;
    mkdirSync(privateWikiDir, { recursive: true });
    process.stdout.write(`    Wiki dir → ${privateWikiDir}\n`);
  }
  if (privacyMode === "http-server" && httpServerUrl) {
    configUpdates["serverUrl"] = httpServerUrl.replace(/\/$/, "");
  }
  writeProjectConfig(cwd, configUpdates);

  // Path 1 auto-gitignore — hide local Gyst state from the project's git history.
  if (privacyMode === "local") {
    const added = ensureGitignore(cwd);
    if (added.length > 0) {
      process.stdout.write(`    Added to .gitignore: ${added.join(", ")}\n`);
    } else {
      process.stdout.write("    .gitignore already hides Gyst state — skipped\n");
    }
  }

  // Step 5: Convention scanning (automated, capped at 30)
  const { loadConfig } = await import("../utils/config.js");
  const db = initDatabase(loadConfig(cwd).dbPath);
  const conventionCount = await scanAndSaveConventions(db, process.cwd());
  db.close();

  // Step 6: Git hooks (inline, no external scripts)
  process.stdout.write("\n  ✓ Installing git hooks...\n");
  const gitResult = installGitHooks(process.cwd());
  if (gitResult.noGit) {
    process.stdout.write("    No .git/ found — skipping git hooks.\n");
  } else {
    for (const f of gitResult.installed) {
      process.stdout.write(`    .git/hooks/${f} ✓\n`);
    }
    for (const f of gitResult.skipped) {
      process.stdout.write(`    .git/hooks/${f} already has gyst — skipped\n`);
    }
  }

  // Step 7: Tool-specific session hooks
  process.stdout.write("\n  ✓ Registering session hooks...\n");
  await registerHooks(tools);

  // Step 8: Write agent rule files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.)
  process.stdout.write("\n  ✓ Writing agent rule files...\n");
  try {
    const ruleFilesWritten = writeAgentRules(process.cwd());
    if (ruleFilesWritten.length === 0) {
      process.stdout.write("    All rule files already have Gyst section — skipped\n");
    } else {
      for (const f of ruleFilesWritten) {
        process.stdout.write(`    ${f} ✓\n`);
      }
    }
  } catch (err) {
    logger.warn("install: failed to write agent rule files", { error: err });
    process.stdout.write("    ✗ Could not write agent rule files (see logs)\n");
  }

  // Step 9: Agent instructions
  const configuredNames = detectedTools.map((t) => t.name).join(", ") || "none";
  const modeLabel =
    privacyMode === "local"
      ? "Local only"
      : privacyMode === "private-repo"
      ? `Private wiki repo (${privateWikiDir ?? "?"})`
      : `HTTP server (${httpServerUrl ?? "?"})`;
  process.stdout.write(`
  ${"═".repeat(56)}
  ✓ Gyst installed. Restart your AI tool to activate.

  Tools configured:  ${configuredNames}
  Database:          .gyst/wiki.db
  Conventions:       ${conventionCount} detected
  Privacy mode:      ${modeLabel}
  ${"═".repeat(56)}

  On your next session, tell your agent:

    "Scan this project with Gyst. Read the README, package.json,
    recent git history, and key source files. Use the learn tool
    to record important conventions, decisions, error patterns,
    and anything a new developer should know."

  The agent will use Gyst's learn tool to populate your knowledge
  base automatically. It understands your code better than any
  script can.

  Or run: gyst ghost-init to add unwritten team rules manually.

`);

  try {
    stdinReader.releaseLock();
  } catch {
    // ignore — stream may already be closed.
  }
}
