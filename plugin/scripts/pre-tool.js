#!/usr/bin/env node
/**
 * PreToolUse hook for Claude Code, Gemini CLI, Cursor, Windsurf, and Codex CLI.
 *
 * Shows the gyst badge and emits a pre_tool_use event.
 * Always returns {continue: true} — never blocks a tool call.
 */
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const toolName  = input.tool_name  ?? "unknown";
  const sessionId = input.session_id ?? null;

  badge(`watching ${toolName}`);
  emitAsync(gyst, "pre_tool_use", { tool: toolName, sessionId });

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
