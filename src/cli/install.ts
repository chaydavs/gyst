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
      configPath: join(home, ".claude", "settings.json"),
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
      configPath: join(home, ".codex", "config.json"),
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
 * Returns a new config with Gyst's SessionStart and PreCompact hooks merged
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
        command: "gyst inject-context --always-on --graph-traverse" 
      }
    ],
  };
  const gystPreCompact: HookEntry = {
    matcher: "auto",
    hooks: [{ type: "command", command: "gyst harvest-session" }],
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
    },
  };
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
  // at gyst-wiki/.wiki.db — NOT here — to keep one canonical DB location.
}

// ---------------------------------------------------------------------------
// Stdin helpers (interactive I/O)
// ---------------------------------------------------------------------------

/** Prints an inline y/n prompt and returns true for y/yes. */
async function askYesNo(question: string): Promise<boolean> {
  process.stdout.write(`\n  ? ${question} (y/n) `);
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("\n")) break;
  }
  reader.releaseLock();
  const answer = buffer.split("\n")[0]!.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------------------
// Step 3 (interactive) — Register MCP configs
// ---------------------------------------------------------------------------

async function registerMcpForTools(tools: ToolInfo[]): Promise<string[]> {
  const configured: string[] = [];

  for (const tool of tools.filter((t) => t.detected)) {
    const existing = readJsonConfig(tool.configPath);
    const alreadyConfigured =
      typeof existing.mcpServers === "object" &&
      existing.mcpServers !== null &&
      "gyst" in existing.mcpServers;

    if (alreadyConfigured) {
      const overwrite = await askYesNo(
        `Gyst is already configured for ${tool.name}. Overwrite?`,
      );
      if (!overwrite) {
        process.stdout.write(`    ${tool.name}: skipped (already configured)\n`);
        configured.push(tool.name);
        continue;
      }
    }

    try {
      writeJsonConfig(tool.configPath, mergeGystMcpEntry(existing));
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
  { file: "post-commit", line: "gyst harvest-session 2>/dev/null || true" },
  { file: "post-merge", line: "gyst rebuild 2>/dev/null || true" },
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

async function registerHooks(claudeTool: ToolInfo | undefined): Promise<boolean> {
  if (!claudeTool?.detected) return false;

  try {
    const existing = readJsonConfig(claudeTool.configPath);
    writeJsonConfig(claudeTool.configPath, mergeClaudeHooks(existing));
    process.stdout.write("    Claude Code: SessionStart context injection ✓\n");
    process.stdout.write("    Claude Code: PreCompact session harvesting ✓\n");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`    Claude Code hooks: failed (${msg})\n`);
    logger.warn("install: failed to write Claude Code hooks", { error: msg });
    return false;
  }
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

  // Step 3: MCP registration
  const detectedTools = tools.filter((t) => t.detected);
  if (detectedTools.length > 0) {
    process.stdout.write("\n  ✓ Registering Gyst MCP server...\n");
    await registerMcpForTools(tools);
  }

  // Step 4: Project init
  process.stdout.write("\n  ✓ Initializing project...\n");
  const alreadyInit = existsSync(join(process.cwd(), ".gyst"));
  if (alreadyInit) {
    const reinit = await askYesNo("Gyst already initialized. Reinitialize?");
    if (reinit) {
      initProject();
      process.stdout.write("    Reinitialized .gyst/ and gyst-wiki/\n");
    } else {
      process.stdout.write("    Skipping project initialization.\n");
    }
  } else {
    initProject();
    process.stdout.write("    Created .gyst/\n");
    process.stdout.write("    Created gyst-wiki/\n");
  }

  // Step 5: Convention scanning (automated, capped at 30)
  const { loadConfig } = await import("../utils/config.js");
  const db = initDatabase(loadConfig().dbPath);
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

  // Step 7: Claude Code session hooks
  const claudeTool = tools.find((t) => t.name === "Claude Code");
  if (claudeTool?.detected) {
    process.stdout.write("\n  ✓ Registering Claude Code session hooks...\n");
    await registerHooks(claudeTool);
  }

  // Step 8: Agent instructions
  const configuredNames = detectedTools.map((t) => t.name).join(", ") || "none";
  process.stdout.write(`
  ${"═".repeat(56)}
  ✓ Gyst installed. Restart your AI tool to activate.

  Tools configured:  ${configuredNames}
  Database:          .gyst/wiki.db
  Conventions:       ${conventionCount} detected
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
}
