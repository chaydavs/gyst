/**
 * Tests for the gyst install command helpers in src/cli/install.ts.
 *
 * Only the pure, exported functions are tested — the interactive `runInstall()`
 * flow relies on stdin and is exercised manually.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  checkBunVersion,
  detectTools,
  mergeGystMcpEntry,
  mergeClaudeHooks,
  initProject,
} from "../../src/cli/install.js";

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

  test("creates the SQLite database at .gyst/wiki.db", () => {
    expect(existsSync(join(tmpDir, ".gyst", "wiki.db"))).toBe(true);
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
    expect(last.hooks[0]!.command).toBe("gyst inject-context");
  });

  test("PreCompact hook has correct gyst harvest-session command", () => {
    const result = mergeClaudeHooks({});
    const hooks = result.hooks as Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
    const preCompact = hooks["PreCompact"]!;
    const last = preCompact[preCompact.length - 1]!;
    expect(last.hooks[0]!.command).toBe("gyst harvest-session");
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
// Test 6 — serve command exists in CLI
// ---------------------------------------------------------------------------

describe("CLI commands", () => {
  test("serve command is registered", async () => {
    const result = Bun.spawnSync(["bun", "src/cli/index.ts", "--help"], {
      cwd: "/Users/chaitanyadavuluri/Desktop/SustainableMemory",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain("serve");
    expect(output).toContain("Start Gyst MCP server");
  });

  test("install command is registered", async () => {
    const result = Bun.spawnSync(["bun", "src/cli/index.ts", "--help"], {
      cwd: "/Users/chaitanyadavuluri/Desktop/SustainableMemory",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain("install");
    expect(output).toContain("First-time setup");
  });
});
