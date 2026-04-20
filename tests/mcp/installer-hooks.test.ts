import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHooksForDetectedTools } from "../../src/mcp/installer.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "gyst-hooks-test-"));
}

test("writes Gemini hook config when .gemini exists", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, ".gemini"), { recursive: true });
    const configured = installHooksForDetectedTools(tmp, join(tmp, "scripts"));
    expect(configured).toContain("Gemini CLI");
    const config = JSON.parse(readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8"));
    expect(config.hooks.SessionStart[0].command).toContain("session-start.js");
    expect(config.hooks.SessionStart[0].command).toContain(join(tmp, "scripts"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writes Cursor hook config when .cursor exists", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, ".cursor"), { recursive: true });
    const configured = installHooksForDetectedTools(tmp, join(tmp, "scripts"));
    expect(configured).toContain("Cursor");
    const config = JSON.parse(readFileSync(join(tmp, ".cursor", "hooks.json"), "utf-8"));
    expect(config.version).toBe(1);
    expect(config.hooks.sessionStart[0].command).toContain("session-start.js");
    expect(config.hooks.sessionStart[0].timeout).toBe(5);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writes Windsurf hook config when .codeium/windsurf exists", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, ".codeium", "windsurf"), { recursive: true });
    const configured = installHooksForDetectedTools(tmp, join(tmp, "scripts"));
    expect(configured).toContain("Windsurf");
    const config = JSON.parse(readFileSync(join(tmp, ".codeium", "windsurf", "hooks.json"), "utf-8"));
    expect(config.hooks.pre_session[0].command).toContain("session-start.js");
    expect(config.hooks.pre_session[0].type).toBeUndefined();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writes Codex hook config when .codex exists", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, ".codex"), { recursive: true });
    const configured = installHooksForDetectedTools(tmp, join(tmp, "scripts"));
    expect(configured).toContain("Codex CLI");
    const config = JSON.parse(readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8"));
    expect(config.hooks.SessionStart[0].command).toContain("session-start.js");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("skips tools whose detection dir does not exist", () => {
  const tmp = makeTmp();
  try {
    const configured = installHooksForDetectedTools(tmp, join(tmp, "scripts"));
    expect(configured).toHaveLength(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("is idempotent — running twice does not create duplicate hook entries", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, ".gemini"), { recursive: true });
    const scripts = join(tmp, "scripts");
    installHooksForDetectedTools(tmp, scripts);
    installHooksForDetectedTools(tmp, scripts);
    const config = JSON.parse(readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8"));
    expect(config.hooks.SessionStart).toHaveLength(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preserves pre-existing hook entries in settings.json", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, ".gemini"), { recursive: true });
    writeFileSync(
      join(tmp, ".gemini", "settings.json"),
      JSON.stringify({ hooks: { MyCustomHook: [{ command: "custom" }] } }),
      "utf-8"
    );
    installHooksForDetectedTools(tmp, join(tmp, "scripts"));
    const config = JSON.parse(readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8"));
    expect(config.hooks.SessionStart).toBeDefined();
    expect(config.hooks.MyCustomHook).toBeDefined();
    expect(config.hooks.MyCustomHook[0].command).toBe("custom");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
