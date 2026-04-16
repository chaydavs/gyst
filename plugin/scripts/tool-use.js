#!/usr/bin/env node
/**
 * Claude Code / Codex PostToolUse hook.
 *
 * Reads the hook JSON from stdin and extracts tool name + error state so
 * the classifier can promote real failures to error_pattern entries
 * instead of discarding every tool_use as zero-signal.
 *
 * Fire-and-forget: never blocks the agent.
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

function extractError(hookInput) {
  const resp = hookInput.tool_response;
  if (resp && typeof resp === "object") {
    if (resp.is_error === true && typeof resp.content === "string") return resp.content;
    if (typeof resp.error === "string") return resp.error;
    if (typeof resp.stderr === "string" && resp.stderr.length > 0) return resp.stderr;
  }
  return "";
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const hookInput = readHookInput();
  const payload = {
    tool: typeof hookInput.tool_name === "string" ? hookInput.tool_name : null,
    sessionId: typeof hookInput.session_id === "string" ? hookInput.session_id : null,
    error: extractError(hookInput),
  };
  spawnSync(gyst, ["emit", "tool_use"], {
    timeout: 2000,
    input: JSON.stringify(payload),
    stdio: ["pipe", "ignore", "ignore"],
  });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
