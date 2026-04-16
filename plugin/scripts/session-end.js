#!/usr/bin/env node
/**
 * Claude Code / Codex Stop/SessionEnd hook.
 *
 * Records session_end with session_id so downstream distillation can
 * group events per session. Never blocks the agent.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const hookInput = readHookInput();
  const payload = {
    sessionId: typeof hookInput.session_id === "string" ? hookInput.session_id : null,
    reason: hookInput.stop_hook_active === true ? "stop" : "session_end",
  };
  spawnSync(gyst, ["emit", "session_end"], {
    timeout: 2000,
    input: JSON.stringify(payload),
    stdio: ["pipe", "ignore", "ignore"],
  });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
