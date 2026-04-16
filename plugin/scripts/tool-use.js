#!/usr/bin/env node
/**
 * Claude Code / Codex PostToolUse hook.
 *
 * Fire-and-forget event recording. Never blocks the agent.
 */
import { spawnSync } from "node:child_process";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  spawnSync(gyst, ["emit", "tool_use"], { timeout: 2000, stdio: "ignore" });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
