#!/usr/bin/env node
/**
 * Claude Code / Codex SessionStart hook.
 *
 * Records the session_start event and injects recent-context markdown as
 * `additionalContext`. Output must be valid JSON for Claude Code plugin hooks;
 * we wrap the inject-context output in the hook-response envelope.
 *
 * Never blocks the agent: all failures swallow to `{"continue": true}`.
 */
import { spawnSync } from "node:child_process";

function tryCommand(cmd, args) {
  const result = spawnSync(cmd, args, {
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  if (result.status === 0 && typeof result.stdout === "string") return result.stdout;
  return "";
}

function resolveGyst() {
  // Prefer the installed binary; fall back to npx for cold-start dev envs.
  return process.env.GYST_BIN || "gyst";
}

try {
  const gyst = resolveGyst();

  // Fire-and-forget telemetry — ignore output.
  spawnSync(gyst, ["emit", "session_start"], { timeout: 2000, stdio: "ignore" });

  // Context for the agent + a human-friendly notification line on stderr.
  const context = tryCommand(gyst, ["inject-context", "--always-on", "--graph-traverse"]);

  const response = { continue: true };
  if (context.trim().length > 0) response.additionalContext = context;
  process.stdout.write(JSON.stringify(response));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
