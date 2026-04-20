#!/usr/bin/env node
/**
 * UserPromptSubmit hook for Claude Code, Cursor, and Codex CLI.
 *
 * Reads prompt text + session_id and forwards a minimal payload to
 * `gyst emit prompt`. classify-event.ts uses the text to decide candidate
 * type and signal. Fire-and-forget: never blocks the agent.
 */
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const payload = {
    text:      input.prompt_text ?? "",
    sessionId: input.session_id  ?? null,
    cwd:       input.cwd         ?? null,
  };

  badge("recording prompt");
  emitAsync(gyst, "prompt", payload);

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
