#!/usr/bin/env node
/**
 * Claude Code / Codex UserPromptSubmit hook.
 *
 * Reads prompt text + session_id and forwards a minimal payload to
 * `gyst emit prompt`. classify-event.ts uses the text to decide candidate
 * type and signal. Fire-and-forget: never blocks the agent.
 */
import { readFileSync } from "node:fs";
import { emitAsync } from "./badge.js";

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
    text:      typeof hookInput.prompt     === "string" ? hookInput.prompt     : "",
    sessionId: typeof hookInput.session_id === "string" ? hookInput.session_id : null,
    cwd:       typeof hookInput.cwd        === "string" ? hookInput.cwd        : null,
  };

  emitAsync(gyst, "prompt", payload);

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
