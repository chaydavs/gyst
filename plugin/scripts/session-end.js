#!/usr/bin/env node
/**
 * Claude Code / Codex Stop/SessionEnd hook.
 *
 * Records the session_end event. Never blocks the agent.
 */
import { spawnSync } from "node:child_process";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  spawnSync(gyst, ["emit", "session_end"], { timeout: 2000, stdio: "ignore" });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
