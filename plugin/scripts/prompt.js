#!/usr/bin/env node
/**
 * Claude Code / Codex UserPromptSubmit hook.
 *
 * Reads the Claude Code hook JSON from stdin, extracts prompt text +
 * session_id, and forwards a minimal payload to `gyst emit prompt`.
 * classify-event.ts needs the text to decide candidate type and signal —
 * an empty payload makes every prompt look like dead weight.
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

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const hookInput = readHookInput();
  const payload = {
    text: typeof hookInput.prompt === "string" ? hookInput.prompt : "",
    sessionId: typeof hookInput.session_id === "string" ? hookInput.session_id : null,
    cwd: typeof hookInput.cwd === "string" ? hookInput.cwd : null,
  };
  spawnSync(gyst, ["emit", "prompt"], {
    timeout: 2000,
    input: JSON.stringify(payload),
    stdio: ["pipe", "ignore", "ignore"],
  });
  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
