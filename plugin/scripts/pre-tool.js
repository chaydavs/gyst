#!/usr/bin/env node
/**
 * Claude Code / Codex PreToolUse hook.
 *
 * Fires before every tool call. Used to:
 *  1. Show the "gyst is working" badge so the user sees gyst is active.
 *  2. Emit a pre_tool_use event for tracking tool invocation patterns.
 *
 * Always returns {continue: true} — never blocks a tool call.
 * Emission is fire-and-forget (detached spawn).
 */
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

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
  const toolName  = typeof hookInput.tool_name  === "string" ? hookInput.tool_name  : "unknown";
  const sessionId = typeof hookInput.session_id === "string" ? hookInput.session_id : null;

  // Track Read tool calls as KB miss signals — agent needed source, KB didn't have it
  if (hookInput.tool_name === "Read" && hookInput.tool_input?.file_path) {
    emitAsync(gyst, "kb_miss_signal", {
      filePath: hookInput.tool_input.file_path,
      sessionId: hookInput.session_id ?? null,
      reason: "read_tool_used",
    });
  }

  badge(`watching ${toolName}`);

  emitAsync(gyst, "pre_tool_use", { tool: toolName, sessionId });

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
