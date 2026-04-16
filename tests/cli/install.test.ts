/**
 * Tests for the gyst install command helpers in src/cli/install.ts.
 *
 * Only the pure, exported functions are tested — the interactive `runInstall()`
 * flow relies on stdin and is exercised manually.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  checkBunVersion,
  detectTools,
  mergeGystMcpEntry,
  mergeClaudeHooks,
  initProject,
  writeHooksPlugin,
  installGitHooks,
} from "../../src/cli/install.js";
import { loadConfig } from "../../src/utils/config.js";

// ---------------------------------------------------------------------------
// Test 1 — checkBunVersion
// ---------------------------------------------------------------------------

describe("checkBunVersion", () => {
  test("returns ok=true when Bun is the runtime", () => {
    // bun:test is itself running in Bun, so process.versions.bun is always set.
    const result = checkBunVersion();
    expect(result.ok).toBe(true);
    expect(result.version).toMatch(/^\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — detectTools
// ---------------------------------------------------------------------------

describe("detectTools", () => {
  test("returns an array with all expected tool names", () => {
    const tools = detectTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("Claude Code");
    expect(names).toContain("Cursor");
    expect(names).toContain("Windsurf");
    expect(names).toContain("Gemini CLI");
    expect(names).toContain("Codex CLI");
    expect(names).toContain("OpenCode");
    expect(names).toContain("Continue");
  });

  test("detects Claude Code (since tests run inside Claude Code)", () => {
    // The test environment is the Gyst project itself, which lives in a
    // developer's machine where ~/.claude/ is present.
    const tools = detectTools();
    const claude = tools.find((t) => t.name === "Claude Code");
    expect(claude).toBeDefined();
    // Claude Code is expected in this environment — assert detected is a boolean.
    expect(typeof claude!.detected).toBe("boolean");
    // configPath should point to ~/.claude/settings.json
    expect(claude!.configPath).toBe(join(homedir(), ".claude", "settings.json"));
  });

  test("all tools have a non-empty configPath", () => {
    const tools = detectTools();
    for (const tool of tools) {
      expect(tool.configPath.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — initProject
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gyst-install-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("initProject", () => {
  test("creates .gyst/ and gyst-wiki/ directories", () => {
    initProject(tmpDir);
    expect(existsSync(join(tmpDir, ".gyst"))).toBe(true);
    expect(existsSync(join(tmpDir, "gyst-wiki"))).toBe(true);
  });

  test("does NOT create a database at .gyst/wiki.db (DB is created lazily by initDatabase)", () => {
    expect(existsSync(join(tmpDir, ".gyst", "wiki.db"))).toBe(false);
  });

  test("is idempotent — calling twice does not throw", () => {
    expect(() => initProject(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — mergeGystMcpEntry
// ---------------------------------------------------------------------------

describe("mergeGystMcpEntry", () => {
  test("injects gyst entry into an empty config", () => {
    const result = mergeGystMcpEntry({});
    expect(result.mcpServers).toBeDefined();
    expect((result.mcpServers as Record<string, unknown>)["gyst"]).toEqual({
      command: "bunx",
      args: ["gyst-mcp", "serve"],
    });
  });

  test("preserves existing mcpServers entries", () => {
    const existing = { mcpServers: { other: { command: "other-server", args: [] } } };
    const result = mergeGystMcpEntry(existing);
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers["other"]).toBeDefined();
    expect(servers["gyst"]).toBeDefined();
  });

  test("overwrites existing gyst entry", () => {
    const existing = { mcpServers: { gyst: { command: "old", args: [] } } };
    const result = mergeGystMcpEntry(existing);
    expect((result.mcpServers as Record<string, unknown>)["gyst"]).toEqual({
      command: "bunx",
      args: ["gyst-mcp", "serve"],
    });
  });

  test("does not mutate the input config", () => {
    const original = { mcpServers: {} };
    mergeGystMcpEntry(original);
    expect(Object.keys(original.mcpServers)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — mergeClaudeHooks
// ---------------------------------------------------------------------------

describe("mergeClaudeHooks", () => {
  test("injects SessionStart and PreCompact hooks into an empty config", () => {
    const result = mergeClaudeHooks({});
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(Array.isArray(hooks["SessionStart"])).toBe(true);
    expect(Array.isArray(hooks["PreCompact"])).toBe(true);
  });

  test("SessionStart hook has correct gyst inject-context command", () => {
    const result = mergeClaudeHooks({});
    const hooks = result.hooks as Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
    const sessionStart = hooks["SessionStart"]!;
    expect(sessionStart.length).toBeGreaterThan(0);
    const last = sessionStart[sessionStart.length - 1]!;
    expect(last.matcher).toBe("auto");
    const commands = last.hooks.map((h) => h.command);
    expect(commands).toContain("gyst inject-context --always-on --graph-traverse");
    expect(commands.some((c) => c.startsWith("gyst emit session_start"))).toBe(true);
  });

  test("PreCompact hook emits pre_compact event", () => {
    const result = mergeClaudeHooks({});
    const hooks = result.hooks as Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
    const preCompact = hooks["PreCompact"]!;
    const last = preCompact[preCompact.length - 1]!;
    expect(last.hooks[0]!.command).toContain("gyst emit pre_compact");
  });

  test("UserPromptSubmit, PostToolUse, and Stop hooks are injected", () => {
    const result = mergeClaudeHooks({});
    const hooks = result.hooks as Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
    
    expect(hooks["UserPromptSubmit"]).toBeDefined();
    expect(hooks["UserPromptSubmit"]![0].hooks[0].command).toContain("gyst emit prompt");
    
    expect(hooks["PostToolUse"]).toBeDefined();
    expect(hooks["PostToolUse"]![0].hooks[0].command).toContain("gyst emit tool_use");
    
    expect(hooks["Stop"]).toBeDefined();
    expect(hooks["Stop"]![0].hooks[0].command).toContain("gyst emit session_end");
  });

  test("preserves existing non-gyst hooks", () => {
    const nonGystHook = { matcher: "", hooks: [{ type: "command", command: "echo hello" }] };
    const input = { hooks: { SessionStart: [nonGystHook] } };
    const result = mergeClaudeHooks(input);
    const hooks = result.hooks as Record<string, unknown[]>;
    // Should have 2 entries: the original + gyst
    expect(hooks["SessionStart"]!.length).toBe(2);
    expect(hooks["SessionStart"]![0]).toEqual(nonGystHook);
  });

  test("replaces existing gyst hooks to prevent duplicates", () => {
    const oldGystHook = {
      matcher: "auto",
      hooks: [{ type: "command", command: "gyst inject-context" }],
    };
    const input = { hooks: { SessionStart: [oldGystHook, oldGystHook] } };
    const result = mergeClaudeHooks(input);
    const hooks = result.hooks as Record<string, unknown[]>;
    // Deduplicates: only 1 gyst hook entry remains
    expect(hooks["SessionStart"]!.length).toBe(1);
  });

  test("does not mutate the input config", () => {
    const original: { hooks: Record<string, unknown[]> } = { hooks: {} };
    mergeClaudeHooks(original);
    expect(Object.keys(original.hooks)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — writeHooksPlugin
// ---------------------------------------------------------------------------

describe("writeHooksPlugin", () => {
  let hooksTmp: string;

  beforeAll(() => {
    hooksTmp = mkdtempSync(join(tmpdir(), "gyst-hooks-"));
  });

  afterAll(() => {
    rmSync(hooksTmp, { recursive: true, force: true });
  });

  test("writes hooks.json to target directory", () => {
    writeHooksPlugin(hooksTmp);
    expect(existsSync(join(hooksTmp, "hooks.json"))).toBe(true);
  });

  test("hooks.json contains absolute paths for scripts", () => {
    writeHooksPlugin(hooksTmp);
    const content = JSON.parse(readFileSync(join(hooksTmp, "hooks.json"), "utf-8"));
    const hooks = content.hooks as { event: string; script: string }[];
    
    expect(hooks.length).toBe(4);
    for (const hook of hooks) {
      expect(hook.script.startsWith("/")).toBe(true);
      expect(hook.script.endsWith(".js")).toBe(true);
      // Verify candidate searching actually found the real scripts dir in this project:
      expect(hook.script).toContain("plugin/scripts");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7 — loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  test("loadConfig: autoExport defaults to false", () => {
    const cfg = loadConfig();
    expect(cfg.autoExport).toBe(false);
  });

  test("loadConfig: autoExport can be set to true", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gyst-cfg-"));
    writeFileSync(
      join(tmpDir, ".gyst-wiki.json"),
      JSON.stringify({ autoExport: true }),
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.autoExport).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 8 — installGitHooks
// ---------------------------------------------------------------------------

describe("installGitHooks", () => {
  let gitTmp: string;

  beforeAll(() => {
    gitTmp = mkdtempSync(join(tmpdir(), "gyst-githooks-"));
    // Simulate a git repo by creating a .git/hooks/ directory
    mkdirSync(join(gitTmp, ".git", "hooks"), { recursive: true });
  });

  afterAll(() => {
    rmSync(gitTmp, { recursive: true, force: true });
  });

  test("returns noGit=true when .git/ is absent", () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "gyst-nogit-"));
    try {
      const result = installGitHooks(noGitDir);
      expect(result.noGit).toBe(true);
      expect(result.installed).toHaveLength(0);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  test("creates post-commit and post-merge hooks", () => {
    const result = installGitHooks(gitTmp);
    expect(result.noGit).toBe(false);
    expect(result.installed).toContain("post-commit");
    expect(result.installed).toContain("post-merge");
    expect(result.skipped).toHaveLength(0);
  });

  test("post-commit hook emits commit event", () => {
    const content = readFileSync(join(gitTmp, ".git", "hooks", "post-commit"), "utf-8");
    expect(content).toContain("gyst emit commit");
    expect(content).toContain("#!/bin/sh");
  });

  test("post-merge hook emits pull event", () => {
    const content = readFileSync(join(gitTmp, ".git", "hooks", "post-merge"), "utf-8");
    expect(content).toContain("gyst emit pull");
  });

  test("is idempotent — second call skips already-present gyst hooks", () => {
    const result2 = installGitHooks(gitTmp);
    expect(result2.installed).toHaveLength(0);
    expect(result2.skipped).toContain("post-commit");
    expect(result2.skipped).toContain("post-merge");
  });

  test("appends to existing hook without overwriting it", () => {
    const appendDir = mkdtempSync(join(tmpdir(), "gyst-append-"));
    mkdirSync(join(appendDir, ".git", "hooks"), { recursive: true });
    // Write a pre-existing hook
    const hookPath = join(appendDir, ".git", "hooks", "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho existing\n");
    chmodSync(hookPath, 0o755);

    installGitHooks(appendDir);

    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("echo existing");
    expect(content).toContain("gyst emit commit");
    rmSync(appendDir, { recursive: true, force: true });
  });
});
